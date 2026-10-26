/**
 * 沙盒可用性判定 —— 审查 S1/S2 的落点。
 *
 * 三种后端:
 * - `macos-seatbelt`      : macOS 系统级隔离(生产唯一真隔离后端)
 * - `windows-approval-only`: Windows 无 OS 级隔离。用户显式开启后,本机 CLI 可执行,
 *                            但**每一条命令的完整命令行都经审批卡确认并写审计**。
 *                            这里如实标注"无 OS 隔离",不做任何隔离承诺。
 * - 其余平台               : 失败关闭(无可信后端)。
 *
 * 设计约束(不可放松):
 * 1. windows-approval-only 必须由用户在设置中显式开启,默认关闭;
 * 2. 该后端下 GUI 必须持续显示"无 OS 隔离"标识,不得沿用"沙盒"措辞;
 * 3. 审计记录必须包含完整命令行;
 * 4. macOS 上本后端不可选(不能降级掉真隔离)。
 */
export type SandboxBackend = "macos-seatbelt" | "windows-approval-only";

export type SandboxAvailability =
	| { available: true; backend: SandboxBackend; platform: NodeJS.Platform; osIsolation: boolean }
	| {
		available: false;
		reason: "unsupported-platform" | "backend-missing" | "approval-only-disabled";
		platform: NodeJS.Platform;
		message: string;
	};

export interface ApprovalOnlyPreference {
	/** 用户在设置中显式开启:Windows 无隔离执行(每命令审批)。 */
	enabled: boolean;
}
