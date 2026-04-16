import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { ENV } from "../lib/env.js";
import { BOT_BIENVENIDA } from "./config.js";
import { BotSesion, SedeResumen, ServicioResumen, SlotResumen } from "./types.js";

// ──────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────

const DIAS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES = ["","ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function fmt(fecha: string): string {
  const d = new Date(fecha + "T12:00:00Z");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth() + 1]}`;
}

function horaRD(iso: string): string {
  return new Date(iso).toLocaleTimeString("es-DO", {
    timeZone: "America/Santo_Domingo", hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function hoyRD(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
}

function ahoraRD(): Date {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
}

function telRD(tel: string): string | null {
  const d = tel.replace(/\D/g, "");
  let n = d;
  if (n.length === 11 && n.startsWith("1")) n = n.slice(1);
  if (n.length !== 10) return null;
  if (!["809","829","849"].includes(n.slice(0, 3))) return null;
  return "+1" + n;
}

// ──────────────────────────────────────────────────────────
// DB queries
// ──────────────────────────────────────────────────────────

async function buscarDoctor(texto: string): Promise<any | null> {
  const c = texto.trim();
  if (!c || c.length < 2) return null;
  if (/^\d+$/.test(c)) {
    const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${c}`, activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (Array.isArray(r.data) && r.data[0]) return r.data[0];
  }
  const r = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `(nombre.ilike.*${c}*,apellido.ilike.*${c}*)`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });
  if (!r.data || !Array.isArray(r.data) || r.data.length === 0) return null;
  if (r.data.length === 1) return r.data[0];
  return { multiples: r.data };
}

async function buscarDoctorAgresivo(texto: string): Promise<any | null> {
  const limpio = texto.replace(/[^a-záéíóúñü\s\d]/gi, "").trim();
  let r = await buscarDoctor(limpio);
  if (r) return r;
  const skip = new Set(["que","quien","cual","como","con","por","para","los","las","del","una","uno",
    "ese","esa","doctor","doctora","dra","quiero","busca","buscar","deseo","necesito","donde","esta",
    "nombre","extension","consulta","cita","agendar","ver","saber","hola","buenas","buenos","dias",
    "consultar","queria","querria"]);
  for (const p of limpio.split(/\s+/).filter(w => w.length >= 3)) {
    if (skip.has(p.toLowerCase())) continue;
    r = await buscarDoctor(p);
    if (r) return r;
  }
  return null;
}

async function buscarSedes(doctorId: string): Promise<SedeResumen[]> {
  const r = await supabase<SedeResumen[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`, activo: "eq.true",
    select: "id,clinicas(nombre,ciudad,direccion,telefono)",
  });
  return r.data ?? [];
}

async function buscarServicios(dcId: string): Promise<ServicioResumen[]> {
  const r = await supabase<ServicioResumen[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${dcId}`, activo: "eq.true", invisible_para_pacientes: "eq.false",
    select: "id,nombre,duracion_min,tipo",
  });
  return r.data ?? [];
}

async function buscarSlots(dcId: string, srvId: string, fecha: string): Promise<SlotResumen[]> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: dcId, p_fecha: fecha, p_servicio_id: srvId,
  });
  const hoy = hoyRD();
  const ahora = ahoraRD();
  return (result.data ?? [])
    .filter((s: any) => {
      if (fecha === hoy) {
        const st = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
        if (st <= ahora) return false;
      }
      // Only show slots at :00, :20, :40 (3 per hour, clean intervals)
      const dt = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
      const min = dt.getMinutes();
      return min % 20 === 0;
    })
    .slice(0, 10)
    .map((s: any, i: number) => ({ num: i + 1, hora: horaRD(s.inicia_en), inicia_en: s.inicia_en }));
}

async function agendarCita(s: BotSesion, slot: SlotResumen): Promise<string | null> {
  const parts = (s.nombre ?? "Paciente").split(" ");
  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: s.telefono ?? "", p_nombre: parts[0] ?? "Paciente",
    p_apellido: parts.slice(1).join(" ") || "Paciente",
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) return null;
  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: s.sede_id, p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: s.servicio_id, p_inicia_en: slot.inicia_en,
    p_motivo: s.motivo ?? "Consulta", p_canal: "telegram", p_creado_por: null,
  });
  if (!cita.data?.[0]?.exito) return null;
  return cita.data[0].codigo;
}

// ──────────────────────────────────────────────────────────
// Sede matching — by number, name, or city
// ──────────────────────────────────────────────────────────

/** Remove accents for matching: jimaní → jimani */
function noAccent(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

function matchSede(texto: string, sedes: SedeResumen[]): SedeResumen | SedeResumen[] | undefined {
  const tl = noAccent(texto.toLowerCase().trim());
  const num = parseInt(tl) - 1;
  if (!isNaN(num) && num >= 0 && num < sedes.length) return sedes[num];

  const matches = sedes.filter(s => {
    const n = noAccent(s.clinicas?.nombre?.toLowerCase() ?? "");
    const c = noAccent(s.clinicas?.ciudad?.toLowerCase() ?? "");
    if (n.includes(tl) || tl.includes(n)) return true;
    const words = tl.split(/\s+/).filter(w => w.length >= 3);
    if (words.length > 0 && words.every(w => n.includes(w) || c.includes(w))) return true;
    if (c.includes(tl) || tl.includes(c)) return true;
    return false;
  });

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return matches; // Ambiguous — caller must ask
  return undefined;
}

// ──────────────────────────────────────────────────────────
// Slot matching — by number, time text ("4 pm", "4:00", "16:00")
// ──────────────────────────────────────────────────────────

function matchSlot(texto: string, slots: SlotResumen[]): SlotResumen | undefined {
  const tl = texto.toLowerCase().trim();

  // By option number: "4" = slot #4
  const num = parseInt(tl) - 1;
  if (/^\d+$/.test(tl) && !isNaN(num) && num >= 0 && num < slots.length) return slots[num];

  // Parse user time input
  const timeMatch = tl.match(/(\d{1,2})\s*(?::(\d{2}))?\s*(am|pm|a\.?\s*m\.?|p\.?\s*m\.?)?/i);
  if (!timeMatch) return undefined;

  let hour = parseInt(timeMatch[1]!);
  const min = parseInt(timeMatch[2] ?? "0");
  const ampm = (timeMatch[3] ?? "").replace(/[\.\s]/g, "").toLowerCase();

  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;

  // Find closest slot
  return slots.find(s => {
    const slotDate = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
    return slotDate.getHours() === hour && Math.abs(slotDate.getMinutes() - min) <= 7;
  });
}

// ──────────────────────────────────────────────────────────
// Day matching — by option number OR by date number ("17" = día 17)
// ──────────────────────────────────────────────────────────

function matchDia(texto: string, dias: { fecha: string; total_slots: number }[]): { fecha: string; total_slots: number } | undefined {
  const tl = texto.trim().toLowerCase();

  // Extract any number from the text: "martes 14" → 14, "el 17" → 17, "1" → 1
  const numMatch = tl.match(/\d+/);
  if (!numMatch) return undefined;
  const num = parseInt(numMatch[0]);
  if (isNaN(num)) return undefined;

  // If small number (1-5) and within list range, treat as option index
  if (num >= 1 && num <= dias.length && num <= 5) return dias[num - 1];

  // Otherwise treat as day-of-month
  const byDay = dias.find(d => parseInt(d.fecha.split("-")[2]!) === num);
  if (byDay) return byDay;

  // Last resort: if within list range, use as index
  if (num >= 1 && num <= dias.length) return dias[num - 1];

  return undefined;
}

// ──────────────────────────────────────────────────────────
// Claude — ONLY for light conversation, never for data
// ──────────────────────────────────────────────────────────

async function askClaude(hist: {role:string;content:string}[], sys: string): Promise<string> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ENV.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 300, system: sys, messages: hist }),
  });
  if (!r.ok) return "Disculpe, tuve un problema técnico. Escriba /start para reiniciar.";
  const d = await r.json() as { content?: { text?: string }[] };
  return d.content?.[0]?.text?.trim() ?? "Disculpe, no pude procesar su mensaje.";
}

async function extractData(texto: string): Promise<any> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ENV.CLAUDE_API_KEY, "anthropic-version": "2023-06-01", "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001", max_tokens: 200,
      system: `Extrae datos del mensaje. Responde SOLO JSON puro.
Campos: nombre (del PACIENTE, no del doctor), telefono (solo dígitos, 10+), motivo (solo médico), es_primera (bool).
Si no hay nada, devuelve {}`,
      messages: [{ role: "user", content: texto }],
    }),
  });
  try {
    const d = await r.json() as { content?: { text?: string }[] };
    return JSON.parse((d.content?.[0]?.text ?? "{}").replace(/```json|```/g, "").trim());
  } catch { return {}; }
}

// ──────────────────────────────────────────────────────────
// MAIN FLOW — deterministic, like PHP
// ──────────────────────────────────────────────────────────

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let ses = await getSesion(chatId);
  
  // Asegurar estructura completa de sesión
  ses = {
    sede_id: null,
    servicio_id: null,
    doctor_id: null,
    doctor_nombre: null,
    doctor_extension: null,
    sede_nombre: null,
    nombre: null,
    telefono: null,
    motivo: null,
    es_primera: undefined,
    paso: null,
    dias_disponibles: null,
    slots: null,
    slot_sel: null,
    fecha_sel: null,
    sedes_disponibles: null,
    servicios_disponibles: null,
    doctores_multiples: null,
    historial: ses.historial ?? [],
    ...ses
  };
  
  const hist: {role:string;content:string}[] = ses.historial ?? [];
  const tl = texto.toLowerCase().trim();
  
  // Bandera para saber si necesitamos guardar sesión
  let sesUpdated = false;

  // ════════════════ RESET ════════════════
  if (texto === "/start" || ["hola","buenas","buenos dias","buenas tardes","buenas noches","inicio"].includes(tl)) {
    await deleteSesion(chatId);
    await enviar(chatId, BOT_BIENVENIDA);
    await setSesion(chatId, { historial: [{ role: "assistant", content: BOT_BIENVENIDA }] });
    return;
  }

  // ════════════════ CANCELAR ════════════════
  if (tl === "/cancelar" || tl.includes("cancelar") || tl.includes("cancela")) {
    // Check if user provided a code
    const codeMatch = texto.match(/CITA-[A-Z0-9]+/i) ?? texto.match(/\b([A-Z0-9]{6})\b/);
    if (codeMatch) {
      let code = codeMatch[0].toUpperCase();
      if (!code.startsWith("CITA-")) code = "CITA-" + code;
      const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
        codigo: `eq.${code}`, select: "id,estado", limit: "1",
      });
      if (found.data?.[0] && ["pendiente","confirmada"].includes(found.data[0].estado)) {
        await rpc<any>("fn_cancelar_cita", {
          p_cita_id: found.data[0].id, p_motivo_cancel: "cancelada_paciente",
          p_cancelado_por: null, p_penalizar_paciente: null,
        });
        await enviar(chatId, `Cita ${code} cancelada correctamente.\n\nSi desea agendar otra, escriba /start.`);
        await deleteSesion(chatId);
      } else {
        await enviar(chatId, `No se encontró cita activa con código ${code}.`);
      }
      return;
    }
    // No code provided — ask for it
    ses.paso = "esperando_codigo_cancelar";
    hist.push({ role: "user", content: texto });
    const resp = "Para cancelar, envíe su código de cita.";
    hist.push({ role: "assistant", content: resp });
    ses.historial = hist.slice(-20);
    await setSesion(chatId, ses);
    await enviar(chatId, resp);
    return;
  }

  // Waiting for cancellation code
  if (ses.paso === "esperando_codigo_cancelar") {
    // Extract just the code part, stripping "cita", "cita-", spaces
    let code = texto.trim().toUpperCase().replace(/^CITA[\s-]*/i, "").replace(/\s+/g, "");
    if (code.length < 4) {
      await enviar(chatId, "Código inválido. El formato es CITA-XXXXXX (6 caracteres). Intente de nuevo.");
      return;
    }
    code = "CITA-" + code;
    const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
      codigo: `eq.${code}`, select: "id,estado", limit: "1",
    });
    if (found.data?.[0] && ["pendiente","confirmada"].includes(found.data[0].estado)) {
      await rpc<any>("fn_cancelar_cita", {
        p_cita_id: found.data[0].id, p_motivo_cancel: "cancelada_paciente",
        p_cancelado_por: null, p_penalizar_paciente: null,
      });
      await enviar(chatId, `Cita ${code} cancelada correctamente.\n\nSi desea agendar otra, escriba /start.`);
      await deleteSesion(chatId);
    } else {
      await enviar(chatId, `No se encontró cita activa con código ${code}. Verifique e intente de nuevo.`);
    }
    return;
  }

  // ════════════════ EXTRACT PATIENT DATA ════════════════
  const datos = await extractData(texto);

  // Direct phone detection FIRST (most reliable)
  if (!ses.telefono) {
    const phoneMatch = texto.match(/\b(809|829|849)\d{7}\b/);
    if (phoneMatch) {
      const t = telRD(phoneMatch[0]);
      if (t) { ses.telefono = t; sesUpdated = true; }
    } else if (datos.telefono) {
      const t = telRD(datos.telefono);
      if (t) { ses.telefono = t; sesUpdated = true; }
    }
  }

  // Direct name + motivo extraction from combined messages like "daniela 8098642498. bulto mamas"
  if (!ses.nombre) {
    const phonePat = /\b(809|829|849)\d{7}\b/;
    const medWords = new Set(["bulto","dolor","sangrado","flujo","ardor","chequeo","quiste","masa",
      "nodulo","nódulo","biopsia","mama","mamas","seno","senos","papanicolaou","mamografia","screening",
      "control","revision","seguimiento","consulta","tumor","cancer","cáncer","hpv","citologia"]);

    if (phonePat.test(texto)) {
      // "daniela 8098642498. bulto mamas" → strip phone, split by punctuation
      const withoutPhone = texto.replace(phonePat, "").replace(/[+\d]/g, "");
      // Split on period, comma, dash to separate name from motivo
      const parts = withoutPhone.split(/[.,;-]+/).map(p => p.trim()).filter(p => p.length > 0);

      for (const part of parts) {
        const words = part.split(/\s+/).filter(w => w.length > 0);
        const hasMedical = words.some(w => medWords.has(w.toLowerCase()));
        if (!hasMedical && words.length >= 1 && words.every(w => /^[a-záéíóúñü]+$/i.test(w))) {
          if (!ses.nombre) {
            ses.nombre = words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
            sesUpdated = true;
          }
        } else if (hasMedical && !ses.motivo) {
          ses.motivo = part.trim();
          sesUpdated = true;
        }
      }
    } else if (datos.nombre) {
      ses.nombre = datos.nombre;
      sesUpdated = true;
    }
  }

  // Direct primera/seguimiento detection
  if (ses.es_primera === undefined) {
    if (["primera","primera vez","primera consulta"].some(p => tl.includes(p))) { ses.es_primera = true; sesUpdated = true; }
    else if (["seguimiento","control","revision","revisión","chequeo"].some(p => tl.includes(p))) { ses.es_primera = false; sesUpdated = true; }
    else if (datos.es_primera !== undefined) { ses.es_primera = datos.es_primera; sesUpdated = true; }
  }

  // Direct motivo detection for common medical terms
  if (!ses.motivo) {
    const medTerms = ["bulto","dolor","sangrado","flujo","ardor","picazón","irregularidad",
      "quiste","masa","nódulo","biopsia","papanicolaou","mamografía","screening","revisión anual"];
    if (medTerms.some(t => tl.includes(t)) || datos.motivo) {
      ses.motivo = datos.motivo || texto.trim();
      sesUpdated = true;
    }
  }

  // Guardar sesión si se actualizaron datos
  if (sesUpdated) {
    await setSesion(chatId, ses);
  }

  // ════════════════ FIND DOCTOR ════════════════
  if (!ses.doctor_id && !ses.doctores_multiples) {
    const doc = await buscarDoctorAgresivo(texto);
    if (!doc) {
      await enviar(chatId, "No encontré ese doctor. Verifique el nombre o extensión.");
      return;
    }
    if (doc.multiples) {
      ses.doctores_multiples = doc.multiples;
      const lista = doc.multiples.map((d: any, i: number) =>
        `${i + 1}. Dr. ${d.nombre} ${d.apellido}${d.extension ? ` (ext. ${d.extension})` : ""}`
      ).join("\n");
      const resp = `Encontré varios doctores:\n\n${lista}\n\nIndique el número.`;
      hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
      ses.historial = hist.slice(-20);
      await setSesion(chatId, ses);
      await enviar(chatId, resp);
      return;
    }
    // Single doctor found
    ses.doctor_id = doc.id;
    ses.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
    if (doc.extension) ses.doctor_extension = doc.extension;
    ses.sedes_disponibles = await buscarSedes(doc.id);

    const esp = (doc.especialidades ?? []).map((e: any) => e.especialidades?.nombre).filter(Boolean).join(", ");
    let resp = `He identificado al ${ses.doctor_nombre}`;
    if (esp) resp += ` — ${esp}`;
    if (doc.extension) resp += ` (ext. ${doc.extension})`;
    resp += ".";

    const sedes = ses.sedes_disponibles!;
    if (sedes.length === 1) {
      const u = sedes[0]!;
      ses.sede_id = u.id;
      ses.sede_nombre = `${u.clinicas?.nombre} (${u.clinicas?.ciudad})`;
      ses.servicios_disponibles = await buscarServicios(u.id);
      resp += `\n\nAtiende en: ${u.clinicas?.nombre}, ${u.clinicas?.ciudad}.`;
      if (u.clinicas?.telefono) resp += ` Tel: ${u.clinicas.telefono}`;
      resp += `\n\n¿Es primera consulta o seguimiento?`;
    } else {
      resp += `\n\nSedes disponibles:\n`;
      resp += sedes.map((s, i) => {
        let l = `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`;
        if (s.clinicas?.telefono) l += ` — Tel: ${s.clinicas.telefono}`;
        return l;
      }).join("\n");
      resp += `\n\n¿En cuál sede desea ser atendido?`;
    }
    hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
    ses.historial = hist.slice(-20);
    await setSesion(chatId, ses);
    await enviar(chatId, resp);
    return;
  }

  // ════════════════ SELECT FROM MULTIPLE DOCTORS ════════════════
  if (!ses.doctor_id && ses.doctores_multiples) {
    const num = parseInt(texto) - 1;
    if (isNaN(num) || num < 0 || num >= ses.doctores_multiples.length) {
      await enviar(chatId, "Indique el número del doctor de la lista.");
      return;
    }
    const doc = ses.doctores_multiples[num]!;
    ses.doctor_id = doc.id;
    ses.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
    if (doc.extension) ses.doctor_extension = doc.extension;
    delete ses.doctores_multiples;
    ses.sedes_disponibles = await buscarSedes(doc.id);
    const sedes = ses.sedes_disponibles;
    let resp = `Perfecto. ${ses.doctor_nombre}.`;
    if (sedes.length === 1) {
      const u = sedes[0]!;
      ses.sede_id = u.id;
      ses.sede_nombre = `${u.clinicas?.nombre} (${u.clinicas?.ciudad})`;
      ses.servicios_disponibles = await buscarServicios(u.id);
      resp += ` Atiende en ${u.clinicas?.nombre}.\n\n¿Es primera consulta o seguimiento?`;
    } else {
      resp += `\n\nSedes:\n` + sedes.map((s, i) =>
        `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`
      ).join("\n") + `\n\n¿En cuál sede?`;
    }
    hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
    ses.historial = hist.slice(-20);
    await setSesion(chatId, ses);
    await enviar(chatId, resp);
    return;
  }

  // ════════════════ SELECT SEDE ════════════════
  if (ses.doctor_id && !ses.sede_id && ses.sedes_disponibles) {
    const result = matchSede(texto, ses.sedes_disponibles);
    if (!result) {
      await enviar(chatId, "Indique el número de la sede.");
      return;
    }
    // Ambiguous — multiple sedes match (e.g. 2 in Santo Domingo)
    if (Array.isArray(result)) {
      const lista = result.map((s, i) => {
        // Find original index in full sedes list
        const origIdx = ses.sedes_disponibles!.indexOf(s) + 1;
        let l = `${origIdx}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`;
        if (s.clinicas?.telefono) l += ` — Tel: ${s.clinicas.telefono}`;
        return l;
      }).join("\n");
      const resp = `Hay varias sedes en esa zona:\n\n${lista}\n\nIndique el número.`;
      hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
      ses.historial = hist.slice(-20);
      await setSesion(chatId, ses);
      await enviar(chatId, resp);
      return;
    }
    // Single match
    const sede = result;
    ses.sede_id = sede.id;
    ses.sede_nombre = `${sede.clinicas?.nombre} (${sede.clinicas?.ciudad})`;
    ses.servicios_disponibles = await buscarServicios(sede.id);
    let resp = `${sede.clinicas?.nombre}, ${sede.clinicas?.ciudad}.`;
    if (sede.clinicas?.direccion) resp += `\nDirección: ${sede.clinicas.direccion}`;
    if (sede.clinicas?.telefono) resp += `\nTeléfono: ${sede.clinicas.telefono}`;
    resp += `\n\n¿Primera consulta o seguimiento?`;
    hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
    ses.historial = hist.slice(-20);
    await setSesion(chatId, ses);
    await enviar(chatId, resp);
    return;
  }

  // ════════════════ COLLECT MISSING DATA ════════════════

  // Resolve service
  if (ses.sede_id && ses.es_primera !== undefined && !ses.servicio_id) {
    const srvs = ses.servicios_disponibles ?? [];
    const srv = ses.es_primera
      ? srvs.find(s => s.tipo === "primera_vez") ?? srvs[0]
      : srvs.find(s => s.tipo === "normal" || s.tipo === "rapida") ?? srvs[0];
    if (srv) ses.servicio_id = srv.id;
  }
  // Fallback service
  if (ses.sede_id && !ses.servicio_id && ses.nombre && ses.telefono && ses.motivo) {
    const srvs = ses.servicios_disponibles ?? [];
    const srv = srvs.find(s => s.tipo === "normal") ?? srvs[0];
    if (srv) ses.servicio_id = srv.id;
  }

  // ════════════════ CHOOSE DAY ════════════════
  if (ses.paso === "elegir_dia" && ses.dias_disponibles) {
    const dia = matchDia(texto, ses.dias_disponibles);
    if (!dia) {
      await enviar(chatId, "Indique el número del día.");
      return;
    }
    const slots = await buscarSlots(ses.sede_id!, ses.servicio_id!, dia.fecha);
    if (slots.length === 0) {
      await enviar(chatId, "Ya no quedan horarios para ese día. Seleccione otro.");
      return;
    }
    ses.fecha_sel = dia.fecha;
    ses.slots = slots;
    ses.paso = "elegir_hora";
    const lista = slots.map(s => `${s.num}. ${s.hora}`).join("\n");
    const resp = `${fmt(dia.fecha)}:\n\n${lista}\n\n¿Cuál horario prefiere?`;
    hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
    ses.historial = hist.slice(-20);
    await setSesion(chatId, ses);
    await enviar(chatId, resp);
    return;
  }

  // ════════════════ CHOOSE TIME ════════════════
  if (ses.paso === "elegir_hora" && ses.slots) {
    const slot = matchSlot(texto, ses.slots);
    if (!slot) {
      await enviar(chatId, "No identifiqué el horario. Indique el número de la lista.");
      return;
    }
    // Verify not passed
    if (ses.fecha_sel === hoyRD()) {
      const slotT = new Date(new Date(slot.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
      if (slotT <= ahoraRD()) {
        await enviar(chatId, "Ese horario ya pasó. Seleccione otro.");
        return;
      }
    }
    // Check we have all patient data
    if (!ses.nombre || !ses.telefono) {
      ses.slot_sel = slot;
      ses.paso = "elegir_hora"; // stay
      let resp = `Hora seleccionada: ${slot.hora}.\nAntes de confirmar, necesito:\n`;
      if (!ses.nombre) resp += "- Su nombre completo\n";
      if (!ses.telefono) resp += "- Su teléfono (10 dígitos)\n";
      hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
      ses.historial = hist.slice(-20);
      await setSesion(chatId, ses);
      await enviar(chatId, resp);
      return;
    }
    // Book it
    const codigo = await agendarCita(ses, slot);
    if (!codigo) {
      await enviar(chatId, "Ese horario ya no está disponible. Escriba /start.");
      return;
    }
    const confirmacion =
      `Cita confirmada.\n\n` +
      `${ses.doctor_nombre}\n` +
      `${fmt(ses.fecha_sel!)} — ${slot.hora}\n` +
      `${ses.nombre}\n` +
      `${ses.sede_nombre}\n\n` +
      `Código: ${codigo}\n` +
      `Para cancelar, escriba: cancelar ${codigo}`;
    await enviar(chatId, confirmacion);
    // Keep minimal session with booking info
    await setSesion(chatId, {
      ultima_cita_codigo: codigo,
      doctor_nombre: ses.doctor_nombre,
      sede_nombre: ses.sede_nombre,
      historial: [{ role: "assistant", content: confirmacion }],
    });
    return;
  }

  // ════════════════ AUTO-TRIGGER: ALL DATA READY → SEARCH SLOTS ════════════════
  console.log(`[DATOS] sede=${!!ses.sede_id} srv=${!!ses.servicio_id} nombre="${ses.nombre ?? "?"}" tel=${!!ses.telefono} motivo="${ses.motivo ?? "?"}" paso=${ses.paso ?? "-"}`);

  if (ses.sede_id && ses.servicio_id && ses.nombre && ses.telefono && ses.motivo
      && ses.paso !== "elegir_dia" && ses.paso !== "elegir_hora") {
    console.log("[AUTO-TRIGGER] ¡Todos los datos listos! Buscando disponibilidad...");
    const diasR = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: ses.sede_id, p_servicio_id: ses.servicio_id,
      p_dias_adelante: 14, p_max_resultados: 5,
    });
    let dias = (diasR.data ?? []).filter((d: any) => d.fecha >= hoyRD());
    if (dias.length === 0) {
      await enviar(chatId, "No hay disponibilidad en los próximos 14 días. Intente con otra sede o llame directamente.");
      return;
    }
    ses.dias_disponibles = dias;
    ses.paso = "elegir_dia";
    const lista = dias.map((d: any, i: number) =>
      `${i + 1}. ${fmt(d.fecha)} — ${d.total_slots} horarios`
    ).join("\n");
    const resp = `${ses.nombre} | ${ses.sede_nombre}\n\nDías disponibles:\n\n${lista}\n\n¿Para qué día le reservo?`;
    hist.push({ role: "user", content: texto }, { role: "assistant", content: resp });
    ses.historial = hist.slice(-20);
    await setSesion(chatId, ses);
    await enviar(chatId, resp);
    return;
  }

  // ════════════════ COLLECT REMAINING DATA VIA CLAUDE ════════════════
  // Only reaches here if some data is missing (name, phone, motive, type)
  console.log(`[CLAUDE FALLBACK] Datos faltantes — entrando a conversación`);

  let pendientes: string[] = [];
  if (ses.sede_id && ses.es_primera === undefined) pendientes.push("tipo de consulta (primera vez o seguimiento)");
  if (ses.sede_id && !ses.nombre) pendientes.push("nombre completo");
  if (ses.sede_id && !ses.telefono) pendientes.push("teléfono (10 dígitos)");
  if (ses.sede_id && !ses.motivo) pendientes.push("motivo de consulta");

  const systemPrompt = `Eres la recepcionista virtual de CitasMed RD. Profesional, cálida, directa. Sin emojis. Máximo 3 líneas.

Doctor: ${ses.doctor_nombre ?? "no identificado"}
Sede: ${ses.sede_nombre ?? "no seleccionada"}
Datos pendientes: ${pendientes.length > 0 ? pendientes.join(", ") : "ninguno"}
Nombre: ${ses.nombre ?? "pendiente"}
Teléfono: ${ses.telefono ?? "pendiente"}
Motivo: ${ses.motivo ?? "pendiente"}
Tipo: ${ses.es_primera === undefined ? "pendiente" : ses.es_primera ? "Primera" : "Seguimiento"}

REGLA ABSOLUTA: NUNCA inventes horarios, fechas, ni datos. Solo pide los datos pendientes al paciente de forma cordial.
Usa: "Con gusto", "Perfecto", "Me permite".`;

  hist.push({ role: "user", content: texto });
  const resp = await askClaude(hist, systemPrompt);
  hist.push({ role: "assistant", content: resp });
  ses.historial = hist.slice(-20);
  await setSesion(chatId, ses);
  await enviar(chatId, resp);
}
