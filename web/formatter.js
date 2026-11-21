let formatter;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function formatSource(source) {
  formatter ??= WebAssembly.instantiate(Uint8Array.from(atob(PUDDI_FORMATTER), c => c.charCodeAt(0)))
    .then(({ instance }) => instance.exports)
    .catch(error => {
      formatter = undefined;
      throw error;
    });
  const wasm = await formatter;
  const input = encoder.encode(source);
  const ptr = wasm.input_ptr(input.length);
  new Uint8Array(wasm.memory.buffer, ptr, input.length).set(input);
  wasm.format_source();
  return decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.output_ptr(), wasm.output_len()));
}
