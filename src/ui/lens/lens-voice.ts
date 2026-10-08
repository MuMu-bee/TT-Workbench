// Lens「屈原语音」：挂载插件现有的屈原语音面板（千问 Realtime 引擎、密钥只在插件可信侧、只读查询）。
// 面板保留自己的样式（宿主带 talos-lens-native，不受 Lens 元素复位影响）；离开模块即卸载、释放麦克风。
import { el, type LensChild } from "./lens-dom";
import type { LensContext } from "./lens-pages";

export function renderVoice(ctx: LensContext): LensChild[] {
	const host = el(ctx.doc, "div", { class: "talos-lens-native talos-lens-voice" });
	ctx.mountVoice(host);
	return [host];
}
