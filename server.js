import "dotenv/config";
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import AdmZip from 'adm-zip';

import { createNasClient, safeName } from './nas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const DIR = path.join(__dirname, 'storage');
const DB = path.join(DIR, 'index.json');

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const nasConfig = {
    baseUrl: process.env.NAS_BASE_URL,
    user: process.env.NAS_USER,
    password: process.env.NAS_PASSWORD,
    path: process.env.NAS_PATH || "/BugPackDev/plaza_folder",
    insecureTls: process.env.NAS_INSECURE_TLS === "true"
};
const nasEnabled = Boolean(nasConfig.baseUrl && nasConfig.user && nasConfig.password);
const nas = nasEnabled ? createNasClient(nasConfig) : null;

const readDb = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, "utf8")) : []);
const writeDb = (x) => fs.writeFileSync(DB, JSON.stringify(x, null, 2));
const updateItem = (id, patch) => {
    const all = readDb();
    const i = all.findIndex((r) => r.id === id);
    if (i < 0) return null;
    all[i] = { ...all[i], ...patch, nas: { ...(all[i].nas || {}), ...(patch.nas || {}) } };
    writeDb(all);
    return all[i];
};

let queue = Promise.resolve();
const queued = new Set();

function queueNasUpload(id) {
    if (!nas || queued.has(id)) return;
    queued.add(id);
    queue = queue.then(async () => {
        const item = readDb().find((r) => r.id === id);
        if (!item || item.nas?.status === "uploaded") return;
        
        const file = path.join(DIR, `${id}.bugpack`);
        if (!fs.existsSync(file)) return;

        try {
            const dateStr = new Date(item.createdAt).toISOString().replace(/:/g, '-').replace(/\..+/, '');
            const safeTitle = (item.title || 'report').normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]/g, "_").substring(0, 30);
            const remoteName = `bug-report-${dateStr}_${safeTitle}.bugpack`;

            const remotePath = await nas.upload(file, remoteName);
            
            updateItem(id, { nas: { status: "uploaded", name: remoteName, path: remotePath, uploadedAt: new Date().toISOString() } });
            console.log(`[NAS] Subido exitosamente: ${remotePath}`);
        } catch (e) {
            updateItem(id, { nas: { status: "error", error: e.message } });
            console.error(`[NAS] Error subiendo ${id}: ${e.message}`);
        }
    }).finally(() => queued.delete(id));
}

const app = express();
app.use(cors());
app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    next();
});

const upload = multer({ dest: path.join(DIR, 'tmp') });

// ============================================================
// ¡AQUÍ ESTÁ EL PUENTE HACIA RENDER!
// ============================================================
app.post('/api/upload-to-render', upload.single('file'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Falta archivo' });

    try {
        console.log("🚀 Reenviando reporte a Render...");
        
        const formData = new FormData();
        const fileBlob = new Blob([fs.readFileSync(req.file.path)], { type: 'application/octet-stream' });
        
        formData.append("file", fileBlob, req.file.originalname);
        formData.append("title", req.body.title || req.file.originalname);
        formData.append("url", req.body.url || "");
        formData.append("env", req.body.env || "");
        formData.append("severity", req.body.severity || "low");

        const response = await fetch("https://bugpack-backend.onrender.com/api/reports", {
            method: "POST",
            body: formData
        });

        if (response.ok) {
            console.log("✅ Reporte subido exitosamente a Render");
            // Limpiamos el archivo temporal
            fs.unlinkSync(req.file.path);
            res.status(200).json({ ok: true });
        } else {
            console.error("❌ Error al subir a Render:", response.status);
            res.status(response.status).json({ error: "Error en Render" });
        }
    } catch (err) {
        console.error("❌ Fallo del proxy:", err);
        res.status(500).json({ error: err.message });
    }
});
// ============================================================

app.get('/api/health', (req, res) => res.json({ ok: true, nas: nasEnabled }));

app.post('/api/reports', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ ok: false, error: 'Falta archivo' });
    
    const id = crypto.randomUUID();
    const filePath = path.join(DIR, `${id}.bugpack`);
    fs.renameSync(req.file.path, filePath);

    // CÁLCULO DE SEVERIDAD EN EL SERVIDOR
    let calculatedSeverity = "low";
    try {
        const zip = new AdmZip(filePath);
        const jsonEntry = zip.getEntries().find(e => e.entryName.endsWith('.json'));
        
        if (jsonEntry) {
            const debugData = JSON.parse(jsonEntry.getData().toString('utf8'));
            const consola = debugData.consoleEvents || [];
            const red = debugData.networkEvents || [];
            
            const errsConsola = consola.filter(e => e.type === 'error').length;
            const errsRed500 = red.filter(e => e.status >= 500).length;
            const errsRed400 = red.filter(e => e.status >= 400 && e.status < 500).length;
            
            if (errsRed500 > 0 || errsConsola >= 5) calculatedSeverity = "high";
            else if (errsConsola > 0 || errsRed400 > 0) calculatedSeverity = "medium";
        }
    } catch (e) {
        console.error("Error al calcular severidad:", e);
    }

    const item = {
        id,
        title: req.body.title || req.file.originalname,
        filename: req.file.originalname,
        size: req.file.size,
        createdAt: new Date().toISOString(),
        url: req.body.url || "",
        env: req.body.env || "",
        severity: calculatedSeverity,
        nas: { status: nas ? "pending" : "disabled" }
    };
    
    writeDb([...readDb(), item]);
    res.status(201).json(item);
    
    queueNasUpload(id);
});

app.get('/api/reports', (req, res) => {
    res.json(readDb().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
});

app.get("/api/reports/:id/bugpack", async (req, res) => {
    const id = path.basename(req.params.id);
    const file = path.join(DIR, `${id}.bugpack`);

    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");

    if (fs.existsSync(file)) return res.download(file, `${id}.bugpack`);

    const item = readDb().find((r) => r.id === id);
    if (nas && item?.nas?.path) {
        try {
            const buf = await nas.download(item.nas.path);
            fs.writeFileSync(file, buf);
            return res.download(file, item.nas.name || `${id}.bugpack`);
        } catch (e) {
            return res.status(500).json({ error: "No se pudo descargar desde el NAS" });
        }
    }
    
    res.status(404).json({ error: "Archivo no encontrado" });
});
function severityFromBuffer(buf) {
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find(e => e.entryName.endsWith('.json'));
    if (!entry) return "low";
    const d = JSON.parse(entry.getData().toString('utf8'));
    const consola = d.consoleEvents || [];
    const red = d.networkEvents || [];
    const errsConsola = consola.filter(e => e.type === 'error').length;
    const errs500 = red.filter(e => e.status >= 500).length;
    const errs400 = red.filter(e => e.status >= 400 && e.status < 500).length;
    if (errs500 > 0 || errsConsola >= 5) return "high";
    if (errsConsola > 0 || errs400 > 0) return "medium";
    return "low";
}
let syncing = false;
async function syncFromNas() {
    if (!nas || syncing) return;
    syncing = true;
    console.log("🔄 Sincronizando reportes desde el NAS...");
    try {
        const remoteFiles = (await nas.listFiles()).filter(f => /\.bugpack$/i.test(f.name)); 
        const known = new Set(readDb().map(r => r.nas?.name).filter(Boolean));
        const pending = remoteFiles.filter(f => !known.has(f.name));
        let addedCount = 0;

        const worker = async () => {
            while (pending.length) {
                const file = pending.shift();
                let severity = "low";
                try {
                    severity = severityFromBuffer(await nas.download(file.path));
                }catch (e) {
                    console.error(`Error al analizar ${file.name}:`, e.message);
                }
                const db = readDb();    
                    // Guardamos temporalmente para leerlo con AdmZip
                    if (db.some(r => r.nas?.name === file.name)) continue;
                     db.push({
                        id: crypto.randomUUID(),
                        title: file.name.replace('.bugpack', ''),
                        filename: file.name,
                        size: file.size,
                        createdAt: file.modifiedAt || new Date().toISOString(),
                        url: "",
                        env: "unknown",
                        severity,
                        nas: { status: "uploaded", name: file.name, path: file.path }
                    });
                    writeDb(db);
                    added++;
                } 
            };
            await Promise.all([worker(), worker(), worker()]);
            console.log(added ? `✅ Se recuperaron ${added} reportes desde el NAS.` : "✅ No hay reportes nuevos en el NAS.");
        } catch (e) {
            console.error("Error al sincronizar con el NAS:", e.message);
        } finally {
            syncing = false;
        }
    }
app.post('/api/sync', (req, res) => {
    syncFromNas(); 
    res.json({
        ok: true,
    });
});
app.listen(PORT, "0.0.0.0",() => {
    console.log(`Servidor BugPack escuchando en el puerto ${PORT}`);
    syncFromNas();
});
