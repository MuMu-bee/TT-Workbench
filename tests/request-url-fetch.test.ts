import { describe, expect, it, vi } from "vitest";
import { createRequestUrlFetch } from "../src/ai/provider/request-url-fetch";

describe("requestUrl fetch transport", () => {
	it("converts a CORS-free buffered response into the fetch contract", async () => {
		const request = vi.fn(async () => ({
			arrayBuffer: new TextEncoder().encode("data: {\"ok\":true}\n\n").buffer,
			headers: { "content-type": "text/event-stream" },
			status: 200,
		}));
		const fetcher = createRequestUrlFetch(request);
		const response = await fetcher("http://127.0.0.1:11434/v1/chat/completions", {
			method: "POST",
			headers: {
				Authorization: "Bearer synthetic",
				"content-type": "application/json",
			},
			body: JSON.stringify({ stream: true }),
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/event-stream");
		expect(await response.text()).toBe("data: {\"ok\":true}\n\n");
		expect(request).toHaveBeenCalledWith({
			url: "http://127.0.0.1:11434/v1/chat/completions",
			method: "POST",
			headers: {
				authorization: "Bearer synthetic",
				"content-type": "application/json",
			},
			body: JSON.stringify({ stream: true }),
			throw: false,
		});
	});

	it("does not start a request that was already cancelled", async () => {
		const request = vi.fn(async () => ({
			arrayBuffer: new ArrayBuffer(0),
			headers: {},
			status: 200,
		}));
		const controller = new AbortController();
		controller.abort();
		await expect(createRequestUrlFetch(request)("https://example.test", {
			signal: controller.signal,
		})).rejects.toMatchObject({ name: "AbortError" });
		expect(request).not.toHaveBeenCalled();
	});

	it("rejects a buffered response above the configured low-memory budget", async () => {
		const request = vi.fn(async () => ({
			arrayBuffer: new Uint8Array([1, 2, 3, 4, 5]).buffer,
			headers: {},
			status: 200,
		}));
		await expect(createRequestUrlFetch(request, 4)("https://example.test"))
			.rejects.toThrow("缓冲上限");
	});

	it("rejects body types that requestUrl cannot represent safely", async () => {
		const request = vi.fn();
		await expect(createRequestUrlFetch(request)(new URL("https://example.test"), {
			method: "POST",
			body: new Uint8Array([1, 2, 3]),
		})).rejects.toThrow("字符串请求体");
		expect(request).not.toHaveBeenCalled();
	});

	it("converges on the abort instead of waiting for the buffered response", async () => {
		// requestUrl 没有 signal 字段：底层请求照旧跑满 400ms，但调用方必须立刻拿到 AbortError。
		let settled = false;
		const request = vi.fn(
			() =>
				new Promise<{
					arrayBuffer: ArrayBuffer;
					headers: Record<string, string>;
					status: number;
				}>((resolve) => {
					setTimeout(() => {
						settled = true;
						resolve({
							arrayBuffer: new TextEncoder().encode("late").buffer,
							headers: {},
							status: 200,
						});
					}, 400);
				})
		);
		const controller = new AbortController();
		const fetcher = createRequestUrlFetch(request);
		const started = Date.now();
		setTimeout(() => controller.abort(), 20);

		await expect(
			fetcher("https://example.test", { signal: controller.signal })
		).rejects.toMatchObject({ name: "AbortError" });
		const abortedAt = Date.now();
		// abort 在 20ms 发起；若仍是整包缓冲语义，这里会接近 400ms。
		expect(abortedAt - started).toBeLessThan(100);
		expect(settled).toBe(false);
		// 落败请求会在 400ms 后 resolve：必须不产生未处理拒绝，等它收尾再结束用例。
		await new Promise((resolve) => setTimeout(resolve, 420));
		expect(settled).toBe(true);
	});
});
