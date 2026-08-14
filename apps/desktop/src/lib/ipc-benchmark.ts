import { invoke } from "@tauri-apps/api/core";

const SIZES_KIB = [64, 512, 2048, 4096];

export interface IpcMeasurement {
  kib: number;
  ms: number;
  mibPerSecond: number;
  /** False when the transport did not hand back an ArrayBuffer, which is itself a finding. */
  wasBinary: boolean;
}

export interface IpcBenchmark {
  measurements: IpcMeasurement[];
  /** Throughput from the largest successful sample, where fixed overhead matters least. */
  mibPerSecond: number;
}

/**
 * Times round trips of increasing size to characterise the IPC transport.
 *
 * Capture is deliberately not involved. If throughput here is ~1 MiB/s then no amount of
 * capture optimisation will help, and the fix is to stop sending pixels; if it is
 * hundreds of MiB/s, the stall is elsewhere.
 */
export async function measureIpc(): Promise<IpcBenchmark> {
  const measurements: IpcMeasurement[] = [];

  // Warm the transport so the first sample does not absorb one-off setup.
  await invoke("ipc_benchmark", { bytes: 1024 });

  for (const kib of SIZES_KIB) {
    const started = performance.now();
    // Sequential on purpose: concurrent transfers would contend and the per-size timings
    // would measure queueing rather than the transport.
    // eslint-disable-next-line no-await-in-loop
    const payload = await invoke<ArrayBuffer | Uint8Array>("ipc_benchmark", {
      bytes: kib * 1024,
    });
    const ms = performance.now() - started;
    const bytes = payload instanceof Uint8Array ? payload.byteLength : payload.byteLength;

    measurements.push({
      kib,
      ms: Math.round(ms),
      mibPerSecond: ms > 0 ? bytes / 1_048_576 / (ms / 1000) : 0,
      wasBinary: payload instanceof ArrayBuffer || payload instanceof Uint8Array,
    });
  }

  const largest = measurements.at(-1);
  return { measurements, mibPerSecond: largest?.mibPerSecond ?? 0 };
}
