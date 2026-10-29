export interface RequestUrlLikeResponse {
	arrayBuffer: ArrayBuffer;
	headers: Record<string, string>;
	status: number;
}

export interface RequestUrlLikeInput {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	throw?: boolean;
}

export type RequestUrlLike = (
	input: RequestUrlLikeInput,
) => Promise<RequestUrlLikeResponse>;

export const MAX_BUFFERED_PROVIDER_RESPONSE_BYTES = 8 * 1024 * 1024;

function abortError(reason?: unknown): Error {
	if (reason instanceof Error && reason.name === "AbortError") return reason;
	const error = reason instanceof Error
		? new Error(reason.message)
		: new Error("请求已取消");
	error.name = "AbortError";
	return error;
}

function inputUrl(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function headerRecord(value?: HeadersInit): Record<string, string> {
	if (!value) return {};
	const headers: Record<string, string> = {};
	new Headers(value).forEach((headerValue, key) => {
		headers[key] = headerValue;
	});
	return headers;
}

/**
 * Adapts Obsidian requestUrl to the fetch contract used by API model clients.
 * requestUrl bypasses renderer CORS, but returns a buffered response; callers
 * still parse SSE framing while accepting that deltas arrive after buffering.
 *
 * 取消语义的边界（本层能做到与做不到的事）：
 * - Obsidian 的 `RequestUrlParam` 没有 `signal` 字段（见
 *   `node_modules/obsidian/obsidian.d.ts` 的 RequestUrlParam 定义），因此本层
 *   **无法中止在途 HTTP**，请求本身仍会跑完。
 * - 本层能做到的是「abort 时调用方立刻拿到 `AbortError`」：用 `Promise.race`
 *   让取消收敛于 abort 时刻，而不是等整包缓冲完成。
 * - 「照常计费」那一半在 transport 层解决，**不在本层修复范围**。
 */
export function createRequestUrlFetch(
	request: RequestUrlLike,
	maxResponseBytes = MAX_BUFFERED_PROVIDER_RESPONSE_BYTES,
): typeof fetch {
	if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
		throw new Error("requestUrl 响应缓冲上限无效");
	}
	return async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
		if (init.signal?.aborted) throw abortError(init.signal.reason);
		if (init.body !== undefined && typeof init.body !== "string") {
			throw new Error("requestUrl transport 只接受字符串请求体");
		}
		const reqPromise = request({
			url: inputUrl(input),
			method: init.method ?? "GET",
			headers: headerRecord(init.headers),
			...(typeof init.body === "string" ? { body: init.body } : {}),
			throw: false,
		});
		// RequestInit.signal 是可选字段：必须在 addEventListener 之前守卫，
		// 否则无 signal 的调用点会抛 TypeError（本层既有行为必须保持不变）。
		let onAbort: (() => void) | null = null;
		const abortPromise = init.signal
			? new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(abortError(init.signal?.reason));
				init.signal?.addEventListener("abort", onAbort, { once: true });
			})
			: null;
		// 落败的 reqPromise 仍会在请求完成后 settle，拒绝必须被吃掉，
		// 否则会产生 unhandledRejection。
		reqPromise.catch(() => undefined);
		let result: RequestUrlLikeResponse;
		try {
			result = abortPromise
				? await Promise.race([reqPromise, abortPromise])
				: await reqPromise;
		} finally {
			if (onAbort) init.signal?.removeEventListener("abort", onAbort);
		}
		if (init.signal?.aborted) throw abortError(init.signal.reason);
		if (result.arrayBuffer.byteLength > maxResponseBytes) {
			throw new Error(`Provider 响应超过 ${maxResponseBytes} bytes 缓冲上限`);
		}
		return new Response(result.arrayBuffer, {
			status: result.status,
			headers: result.headers,
		});
	};
}
