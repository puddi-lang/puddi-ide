export async function compilerDirectory() {
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('puddi-ide', { create: true });
  } catch {
    // Private browsing and managed profiles can disable origin storage.
    return undefined;
  }
}

export async function readCompiler(directory, name, size) {
  try {
    const file = await (await directory.getFileHandle(name)).getFile();
    return file.size === size ? await file.arrayBuffer() : undefined;
  } catch {
    return undefined;
  }
}

export async function saveCompiler(directory, name, bytes) {
  const file = await directory.getFileHandle(name, { create: true });
  if (typeof file.createWritable === 'function') {
    const writer = await file.createWritable();
    try {
      await writer.write(bytes);
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    return;
  }

  // Dedicated Workers also have synchronous access in browsers where the
  // writable stream API is unavailable.
  const access = await file.createSyncAccessHandle();
  try {
    access.truncate(0);
    const length = access.write(new Uint8Array(bytes), { at: 0 });
    if (length !== bytes.byteLength) throw new Error('Incomplete compiler write');
    access.flush();
  } finally {
    access.close();
  }
}
