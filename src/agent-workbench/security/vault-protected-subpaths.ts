/**
 * 受保护 Vault 子路径(原 Codex 权限档案中的永久禁区,TT 1.1.0 起改为通用模块,
 * OhMyPi 沙箱同样启用:Obsidian 配置目录与 .talos 凭据区一律拒绝读写)。
 */
function safeConfigDir(configDir: string): string {
	const value = configDir.trim().normalize("NFKC").replace(/\\/g, "/");
	if (!value || value.startsWith("/") || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Obsidian 配置目录不可验证");
	return value;
}

export function protectedVaultSubpaths(configDir: string): string[] {
	return [
		safeConfigDir(configDir),
		".talos/private",
		".talos/secrets",
		".talos/credentials",
		// talos 管理目录(审计、权限规则、绑定、外部出库审计)。这是 OS 沙箱拒绝清单
		// (desktop-runtime-factory → process-sandbox 的 deniedVaultSubpaths)的唯一来源,
		// 只补 broker 侧常量等于只做了纵深防御的一半。
		".talos/audit",
		".talos/agent-workbench/v1",
	];
}

/** 兼容别名:历史测试与调用方使用旧名。 */
export const codexProtectedVaultSubpaths = protectedVaultSubpaths;
