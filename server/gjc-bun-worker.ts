import { verifyRuntimeManifest } from './gjc-runtime-manifest.js';
import { runGjcWorkerEntrypoint, type GjcWorkerRuntime } from './gjc-worker.js';

async function loadBunSdkRuntime(): Promise<GjcWorkerRuntime> {
  const sdkPatch = await verifyRuntimeManifest();
  const { createGjcBunSdkAdapter } = await import('./gjc-bun-sdk-adapter.js');
  return createGjcBunSdkAdapter(undefined, sdkPatch);
}

// stdout is owned exclusively by the Protocol v1 entrypoint.
runGjcWorkerEntrypoint(process.stdin, process.stdout, process.stderr, { runtime: loadBunSdkRuntime });
