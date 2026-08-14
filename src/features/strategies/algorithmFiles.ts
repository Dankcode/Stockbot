export const MAX_ALGORITHM_BYTES = 500_000;

export type StrategyUpload = {
  filename: string;
  source: string;
};

function normalizedFilename(name: string) {
  const segments = name.trim().split(/[\\/]/);
  return segments[segments.length - 1] ?? "";
}

export function strategyUploadFrom(name: string, source: string, size: number): StrategyUpload {
  const filename = normalizedFilename(name);
  if (!filename || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.js$/i.test(filename)) {
    throw new Error("Choose a JavaScript strategy file whose name ends in .js.");
  }
  if (!Number.isFinite(size) || size <= 0 || size > MAX_ALGORITHM_BYTES) {
    throw new Error("Strategy files must contain 1–500,000 bytes.");
  }
  if (!source.trim()) throw new Error("The selected strategy file is empty.");
  return { filename, source };
}

export async function readStrategyFile(file: File): Promise<StrategyUpload> {
  return strategyUploadFrom(file.name, await file.text(), file.size);
}
