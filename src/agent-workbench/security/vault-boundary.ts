import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import type { ActionRequest, ActionTarget } from "../contracts/approval";
import { protectedVaultSubpaths } from "./vault-protected-subpaths";

export interface BoundaryTarget extends ActionTarget {
	canonical: string;
	insideVault: boolean;
	permanentlyDenied: boolean;
	reason?: string;
}

export interface BoundaryAssessment {
	targets: BoundaryTarget[];
	hasExternalTarget: boolean;
	hasPermanentDenial: boolean;
	bulkDestructive: boolean;
}

export interface CanonicalPathHost {
	realpath(candidate: string): Promise<string>;
	exists(candidate: string): Promise<boolean>;
	resolve(...parts: string[]): string;
	dirname(candidate: string): string;
	relative(from: string, to: string): string;
	isAbsolute(candidate: string): boolean;
	separator: string;
	caseSensitive: boolean;
}

export class NodeCanonicalPathHost implements CanonicalPathHost {
	readonly separator = path.sep;
	readonly caseSensitive = process.platform !== "darwin" && process.platform !== "win32";
	realpath(candidate: string) { return realpath(candidate); }
	async exists(candidate: string) { try { await lstat(candidate); return true; } catch { return false; } }
	resolve(...parts: string[]) { return path.resolve(...parts); }
	dirname(candidate: string) { return path.dirname(candidate); }
	relative(from: string, to: string) { return path.relative(from, to); }
	isAbsolute(candidate: string) { return path.isAbsolute(candidate); }
}

/**
 * 永久禁区（模块层,不经 governance）。导出以便表驱动防漂移断言。
 * `.talos/credentials` 必须显式列出：裸 `credentials` 只按
 * `portable === segment || startsWith(segment + "/")` 比对，压不住
 * `.talos/credentials/token.json`（`vault-protected-subpaths.ts:12` 与
 * `secret-policy.ts` 都把它当凭据区，三处口径必须一致）。
 */
export const PERMANENT_SEGMENTS = new Set([
	".talos/private", ".talos/secrets", ".talos/credentials", ".git", "credentials", "secrets",
	// talos 管理目录：审计、权限规则、运行时绑定与外部出库审计都在其下。
	// agent 改写自己的审计与授权规则属设计缺口，模块层直接拒。
	".talos/agent-workbench/v1", ".talos/audit",
]);
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|credentials?(?:\..*)?|.*\.(?:pem|key|p12))$/i;
const PATH_ARG = /^(?:\.{0,2}[\\/]|~[\\/]|[A-Za-z]:[\\/]|\/)/;

function comparable(value: string, caseSensitive: boolean): string {
	const normalized = value.normalize("NFC");
	return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

export class VaultBoundary {
	private root: string | null = null;

	constructor(
		private readonly vaultRoot: string,
		private readonly paths: CanonicalPathHost = new NodeCanonicalPathHost(),
		private readonly bulkThreshold = 20,
		private readonly configDir?: string,
	) {}

	private async canonicalRoot(): Promise<string> {
		if (!this.root) this.root = await this.paths.realpath(this.vaultRoot);
		return this.root;
	}

	private async canonicalize(raw: string): Promise<string> {
		if (!raw || raw.includes("\0")) throw new Error("目标路径无效");
		const root = await this.canonicalRoot();
		const resolved = this.paths.resolve(this.paths.isAbsolute(raw) ? raw : this.paths.resolve(root, raw));
		let parent = resolved;
		const tail: string[] = [];
		while (!(await this.paths.exists(parent))) {
			const next = this.paths.dirname(parent);
			if (next === parent) throw new Error("无法解析目标路径");
			tail.unshift(this.paths.relative(next, parent));
			parent = next;
		}
		const realParent = await this.paths.realpath(parent);
		return this.paths.resolve(realParent, ...tail);
	}

	private inside(root: string, candidate: string): boolean {
		const relative = comparable(this.paths.relative(root, candidate), this.paths.caseSensitive);
		return relative === "" || (relative !== ".." && !relative.startsWith(`..${this.paths.separator}`) && !this.paths.isAbsolute(relative));
	}

	/**
	 * 永久禁区清单：固定项 ∪ 由 configDir 派生的受保护子路径。
	 *
	 * 派生而不是只写死在 `PERMANENT_SEGMENTS`：`protectedVaultSubpaths` 是 OS 沙箱拒绝
	 * 清单（`desktop-runtime-factory.ts` → `process-sandbox.ts`）的唯一来源，两处共用同一份
	 * 派生意图才不会分叉。但它会校验 configDir 并在非法时抛错（`vault-protected-subpaths.ts:5-9`），
	 * 所以这里降级为「只用固定项」——不能把校验前移到构造函数，否则
	 * `quyuan-workbench-init.ts` 的 catch 会 `throw error`，坏 configDir 直接打挂工作台启动。
	 * 降级后固定项仍生效，`.talos/credentials` 依然被拒。
	 */
	private permanentSegments(): string[] {
		let derived: string[] = [];
		if (this.configDir) {
			try { derived = protectedVaultSubpaths(this.configDir); } catch { derived = []; }
		}
		return [...new Set([...PERMANENT_SEGMENTS, ...derived])]
			.map((segment) => segment.normalize("NFC").toLocaleLowerCase("en-US"));
	}

	private permanent(relative: string): boolean {
		const portable = relative.split(this.paths.separator).join("/").normalize("NFC").toLocaleLowerCase("en-US");
		if (SECRET_FILE.test(portable)) return true;
		return this.permanentSegments().some((segment) => portable === segment || portable.startsWith(`${segment}/`));
	}

	async inspect(target: ActionTarget): Promise<BoundaryTarget> {
		const root = await this.canonicalRoot();
		const canonical = await this.canonicalize(target.raw);
		const insideVault = this.inside(root, canonical);
		const relative = insideVault ? this.paths.relative(root, canonical) : "";
		const permanentlyDenied = insideVault && this.permanent(relative);
		return {
			...target,
			canonical,
			insideVault,
			permanentlyDenied,
			reason: permanentlyDenied ? "目标属于永久禁区" : undefined,
		};
	}

	async assess(request: ActionRequest): Promise<BoundaryAssessment> {
		const targets = [...request.targets];
		if (request.command) {
			targets.push({ raw: request.command.cwd, role: "source" });
			for (const arg of request.command.args.filter((value) => PATH_ARG.test(value))) {
				targets.push({ raw: arg, role: "source" });
			}
		}
		const inspected = await Promise.all(targets.map((target) => this.inspect(target)));
		return {
			targets: inspected,
			hasExternalTarget: inspected.some((target) => !target.insideVault),
			hasPermanentDenial: inspected.some((target) => target.permanentlyDenied),
			bulkDestructive: request.destructive && inspected.length >= this.bulkThreshold,
		};
	}
}
