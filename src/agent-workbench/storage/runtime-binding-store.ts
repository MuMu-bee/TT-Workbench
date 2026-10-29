import type { NativeSessionBinding, RuntimeId } from "../contracts/runtime-adapter";

export interface HostScopedStore {
	read(): Promise<Record<string, unknown> | null>;
	write(value: Record<string, unknown>): Promise<void>;
}

function bindingKey(
	conversationId: string,
	runtimeId: RuntimeId,
	providerProfileId?: string
): string {
	return `${conversationId}:${runtimeId}:${providerProfileId ?? "native"}`;
}

export class RuntimeBindingStore {
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly store: HostScopedStore) {}

	/**
	 * 唯一事务模板：read→mutate→write 必须串行，否则两处并发 set 各自读到旧快照、
	 * 后写者整体覆盖先写者（报告 A2 实测：`persisted keys: [ 'conv-B:ohmypi:native' ]`）。
	 * `writeWhen` 用来保住「无变更就不写盘」的语义，避免把空操作变成一次全量覆盖写。
	 */
	private transaction<T>(
		mutate: (state: Record<string, unknown>) => Promise<T>,
		writeWhen: (result: T) => boolean = () => true,
	): Promise<T> {
		const operation = this.queue.then(async () => {
			const state = (await this.store.read()) ?? {};
			const result = await mutate(state);
			if (writeWhen(result)) await this.store.write(state);
			return result;
		});
		this.queue = operation.then(() => undefined, () => undefined);
		return operation;
	}

	async get(
		conversationId: string,
		runtimeId: RuntimeId,
		providerProfileId?: string
	): Promise<NativeSessionBinding | null> {
		// 无锁读，但先等写队列排空，与 conversation-input-ledger.ts 的 list() 一致。
		await this.queue;
		const state = await this.store.read();
		const bindings = state?.bindings;
		if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return null;
		const entries = bindings as Record<string, unknown>;
		const value =
			entries[bindingKey(conversationId, runtimeId, providerProfileId)]
			?? (!providerProfileId
				? entries[`${conversationId}:${runtimeId}`]
				: undefined);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		return value as NativeSessionBinding;
	}

	async set(conversationId: string, binding: NativeSessionBinding): Promise<void> {
		await this.transaction((state) => {
			const current = state.bindings;
			const bindings = current && typeof current === "object" && !Array.isArray(current)
				? { ...(current as Record<string, unknown>) }
				: {};
			bindings[bindingKey(conversationId, binding.runtimeId, binding.providerProfileId)] = binding;
			state.bindings = bindings;
			return Promise.resolve();
		});
	}

	async remove(
		conversationId: string,
		runtimeId: RuntimeId,
		providerProfileId?: string
	): Promise<void> {
		await this.transaction<{ changed: boolean }>((state) => {
			const current = state.bindings;
			if (!current || typeof current !== "object" || Array.isArray(current)) {
				return Promise.resolve({ changed: false });
			}
			const bindings = { ...(current as Record<string, unknown>) };
			delete bindings[bindingKey(conversationId, runtimeId, providerProfileId)];
			state.bindings = bindings;
			return Promise.resolve({ changed: true });
		}, (result) => result.changed);
	}
}
