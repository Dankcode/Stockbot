import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateAlgorithm, validateAlgorithmSource } from "./validator.js";

export function hashAlgorithmSource(source) {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

export function normalizeAlgorithmFilename(filename) {
  const raw = String(filename ?? "").trim().normalize("NFKC").replace(/\.js$/i, "");
  const safe = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 64);
  if (!safe) {
    const error = new TypeError("Algorithm filename must contain at least one letter or number.");
    error.code = "ALGORITHM_FILENAME_INVALID";
    throw error;
  }
  return `${safe}.js`;
}

async function filesIn(directory, prefix, uploaded) {
  if (!directory) return [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => ({
      path: path.join(directory, entry.name),
      filename: entry.name,
      id: `${prefix}${entry.name.replace(/\.js$/, "")}`,
      uploaded,
      trusted: !uploaded
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function discoverAlgorithmFiles({ algorithmsDir, uploadsDir = path.join(algorithmsDir, "uploads") }) {
  const [bundled, uploads] = await Promise.all([
    filesIn(algorithmsDir, "", false),
    filesIn(uploadsDir, "uploads/", true)
  ]);
  return Object.freeze([...bundled, ...uploads]);
}

export async function loadAlgorithmFile(filePath, metadata = {}) {
  if (metadata.trusted !== true) {
    const error = new Error("Untrusted algorithm files must be validated and executed through EnginePool.");
    error.code = "ALGORITHM_WORKER_REQUIRED";
    throw error;
  }
  const source = await readFile(filePath, "utf8");
  const file = metadata.filename ?? path.basename(filePath);
  validateAlgorithmSource(source, { file });
  const sourceHash = hashAlgorithmSource(source);
  const moduleUrl = `${pathToFileURL(filePath).href}?sha256=${sourceHash}`;
  const loaded = await import(moduleUrl);
  const algorithm = validateAlgorithm(loaded.default, { file });

  return Object.freeze({
    id: metadata.id ?? file.replace(/\.js$/, ""),
    file,
    path: filePath,
    uploaded: Boolean(metadata.uploaded),
    source,
    sourceHash,
    versionHash: sourceHash,
    name: algorithm.name,
    author: typeof algorithm.author === "string" ? algorithm.author : undefined,
    description: typeof algorithm.description === "string" ? algorithm.description : undefined,
    params: Object.freeze({ ...(algorithm.params ?? {}) }),
    signal: algorithm.signal,
    init: algorithm.init,
    algorithm
  });
}

export async function loadAlgorithmRegistry(options) {
  const files = await discoverAlgorithmFiles(options);
  const algorithms = [];
  const errors = [];
  for (const descriptor of files) {
    try {
      if (descriptor.trusted) {
        algorithms.push(await loadAlgorithmFile(descriptor.path, descriptor));
      } else {
        if (!options.enginePool) {
          const error = new Error("Uploaded algorithms require an EnginePool validator.");
          error.code = "ALGORITHM_WORKER_REQUIRED";
          throw error;
        }
        const source = await readFile(descriptor.path, "utf8");
        validateAlgorithmSource(source, { file: descriptor.filename });
        const sourceHash = hashAlgorithmSource(source);
        const metadata = await options.enginePool.validateAlgorithm({
          algorithmSource: source,
          filename: descriptor.filename
        });
        algorithms.push(
          Object.freeze({
            ...descriptor,
            source,
            sourceHash,
            versionHash: sourceHash,
            name: metadata.name,
            author: metadata.author,
            description: metadata.description,
            params: Object.freeze({ ...(metadata.params ?? {}) }),
            algorithm: null
          })
        );
      }
    } catch (error) {
      errors.push(
        Object.freeze({
          id: descriptor.id,
          file: descriptor.path,
          code: error.code ?? "ALGORITHM_LOAD_FAILED",
          error: error.message
        })
      );
    }
  }
  return Object.freeze({ algorithms: Object.freeze(algorithms), errors: Object.freeze(errors) });
}

/**
 * Validates and installs source through a same-directory temporary file. With
 * overwrite disabled, hard-link creation gives an atomic no-clobber collision
 * check. `preflight` can call the worker validator before any file is written.
 */
export async function installAlgorithmAtomically({
  uploadsDir,
  filename,
  source,
  overwrite = false,
  preflight,
  validationTimeoutMs = 2_000
}) {
  const normalizedFilename = normalizeAlgorithmFilename(filename);
  validateAlgorithmSource(source, { file: normalizedFilename });
  const sourceHash = hashAlgorithmSource(source);

  await mkdir(uploadsDir, { recursive: true });
  const targetPath = path.join(uploadsDir, normalizedFilename);
  const temporaryPath = path.join(uploadsDir, `.${normalizedFilename}.${randomUUID()}.tmp`);
  let previousHash = null;
  let validation;
  try {
    if (overwrite) {
      try {
        previousHash = hashAlgorithmSource(await readFile(targetPath, "utf8"));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } else {
      try {
        await access(targetPath, fsConstants.F_OK);
        const collision = new Error(`Algorithm ${normalizedFilename} already exists.`);
        collision.code = "ALGORITHM_EXISTS";
        throw collision;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }

    if (preflight) {
      validation = await preflight({ source, filename: normalizedFilename, sourceHash });
    } else {
      const { EnginePool } = await import("../engine/pool.js");
      const pool = new EnginePool({ size: 1, timeoutMs: validationTimeoutMs });
      try {
        validation = await pool.validateAlgorithm(
          { algorithmSource: source, filename: normalizedFilename },
          { timeoutMs: validationTimeoutMs }
        );
      } finally {
        await pool.close();
      }
    }

    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(source, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    if (overwrite) {
      await rename(temporaryPath, targetPath);
    } else {
      try {
        await link(temporaryPath, targetPath);
      } catch (error) {
        if (error.code === "EEXIST") {
          const collision = new Error(`Algorithm ${normalizedFilename} already exists.`);
          collision.code = "ALGORITHM_EXISTS";
          throw collision;
        }
        throw error;
      }
      await unlink(temporaryPath);
    }
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") error.cleanupError = cleanupError.message;
    }
    throw error;
  }

  const installed = await stat(targetPath);
  return Object.freeze({
    id: `uploads/${normalizedFilename.replace(/\.js$/, "")}`,
    filename: normalizedFilename,
    path: targetPath,
    sourceHash,
    versionHash: sourceHash,
    previousHash,
    overwritten: previousHash !== null,
    bytes: installed.size,
    validation
  });
}
