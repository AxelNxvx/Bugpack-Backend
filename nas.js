import fs from "fs";
import path from "path";
import { fetch, FormData, Agent } from "undici";

const SESSION_ERRORS = [105, 106, 107, 119];
const FOLDER_ERRORS = [400, 401, 408, 1800, 1801, 1802, 1803, 1804, 1805];
const EXISTS_ERRORS = [414, 418, 189, 419, 1805];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function safeName(name) {
  return String(name)
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
}

export function createNasClient(cfg) {
  const base = String(cfg.baseUrl || "").replace(/\/+$/, "");
  const root = "/" + String(cfg.path || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const dispatcher = cfg.insecureTls ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined;

  let sid = null;
  let cookies = new Map();

  function saveCookies(res) {
    const list = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of list) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      if (i > 0) cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  const cookieHeader = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");

  async function request(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookies.size) headers.Cookie = cookieHeader();
    const res = await fetch(url, {
      ...options,
      headers,
      dispatcher,
      signal: AbortSignal.timeout(options.timeoutMs || 60_000)
    });
    saveCookies(res);
    return res;
  }

  async function json(url, options) {
    const res = await request(url, options);
    const text = await res.text();
    try {
      return { status: res.status, body: JSON.parse(text) };
    } catch {
      return { status: res.status, body: null, raw: text.slice(0, 300) };
    }
  }

  async function login() {
    const url =
      `${base}/webapi/auth.cgi?` +
      new URLSearchParams({
        api: "SYNO.API.Auth",
        version: "3",
        method: "login",
        account: cfg.user,
        passwd: cfg.password,
        session: "FileStation",
        format: "sid"
      });
    const r = await json(url);
    const got = r.body?.data?.sid;
    if (!r.body?.success || !got) {
      const code = r.body?.error?.code ?? r.status;
      throw new Error(`No se pudo iniciar sesión en el NAS (código ${code}).`);
    }
    sid = got;
    return sid;
  }

  const ensureSid = async () => sid || login();

  async function createFolder(fullPath) {
    const parent = path.posix.dirname(fullPath);
    const name = path.posix.basename(fullPath);
    const s = await ensureSid();
    const r = await json(`${base}/webapi/entry.cgi`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        api: "SYNO.FileStation.CreateFolder",
        version: "2",
        method: "create",
        folder_path: JSON.stringify([parent]),
        name: JSON.stringify([name]),
        force_parent: "true",
        _sid: s
      }).toString()
    });
    if (r.body?.success) return true;
    const code = r.body?.error?.code;
    if (EXISTS_ERRORS.includes(code)) return true;
    throw new Error(`No se pudo crear la carpeta ${fullPath} en el NAS (código ${code ?? r.status}).`);
  }

  async function upload(localPath, remoteName, subPath = "") {
    if (!fs.existsSync(localPath)) throw new Error("No existe el archivo local a subir.");
    const parts = String(subPath).split(/[\\/]+/).map(safeName).filter((p) => p && p !== "." && p !== "..");
    const destPath = parts.length ? `${root}/${parts.join("/")}` : root;
    const fileName = safeName(path.basename(remoteName));
    const data = fs.readFileSync(localPath);

    let lastError = "Error desconocido al subir al NAS.";
    let foldersTried = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const s = await ensureSid();
        const form = new FormData();
        form.append("api", "SYNO.FileStation.Upload");
        form.append("version", "2");
        form.append("method", "upload");
        form.append("path", destPath);
        form.append("create_parents", "true");
        form.append("overwrite", "true");
        form.append("_sid", s);
        form.append("file", new Blob([data], { type: "application/octet-stream" }), fileName);

        const r = await json(`${base}/webapi/entry.cgi?_sid=${encodeURIComponent(s)}`, {
          method: "POST",
          body: form,
          timeoutMs: 120_000
        });
        if (r.body?.success) return `${destPath}/${fileName}`;

        const code = r.body?.error?.code ?? r.status;
        if (SESSION_ERRORS.includes(code)) {
          sid = null;
          lastError = `Sesión del NAS expirada (código ${code}).`;
          continue;
        }
        if (!foldersTried && FOLDER_ERRORS.includes(code)) {
          foldersTried = true;
          await createFolder(destPath);
        }
        lastError = `File Station respondió con error (código ${code}). ${r.raw || ""}`.trim();
      } catch (e) {
        lastError = e.message || String(e);
        sid = null;
      }
      await sleep(500 * attempt);
    }
    throw new Error(`${lastError} (tras 3 intentos)`);
  }

  async function download(remotePath) {
    const s = await ensureSid();
    const url =
      `${base}/webapi/entry.cgi?` +
      new URLSearchParams({
        api: "SYNO.FileStation.Download",
        version: "2",
        method: "download",
        path: remotePath,
        mode: "download",
        _sid: s
      });
    const res = await request(url, { timeoutMs: 120_000 });
    if (!res.ok) throw new Error(`NAS respondió HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error("El archivo descargado del NAS está vacío.");
    if (buf[0] === 0x7b) {
      try {
        const j = JSON.parse(buf.toString("utf8"));
        if (j.success === false) throw new Error(`NAS error ${j.error?.code ?? ""}`);
      } catch (e) {
        if (e.message.startsWith("NAS error")) throw e;
      }
    }
    return buf;
  }

  // NUEVA FUNCIÓN: Lista los archivos del NAS
  async function listFiles() {
    const s = await ensureSid();
    const url =
      `${base}/webapi/entry.cgi?` +
      new URLSearchParams({
        api: "SYNO.FileStation.List",
        version: "2",
        method: "list",
        folder_path: root,
        additional: JSON.stringify(["size", "time"]),
        _sid: s
      });
    
    const r = await json(url);
    if (!r.body?.success) throw new Error(`No se pudo listar el NAS (código ${r.body?.error?.code || r.status})`);
    
    const files = r.body.data?.files || [];
    return files
      .filter(f => f.isdir === false) // Solo archivos, no carpetas
      .map(f => ({
        name: f.name,
        path: f.path,
        size: f.additional?.size || 0,
        modifiedAt: f.additional?.time?.mtime ? new Date(f.additional.time.mtime * 1000).toISOString() : null
      }));
  }

  async function ping() {
    sid = null;
    await login();
    return { ok: true, path: root };
  }

  return { upload, download, ping, root, listFiles };
}
