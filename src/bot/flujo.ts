import { getSesion, setSesion, deleteSesion } from "./sesion.js";
import { enviar } from "./telegram.js";
import { rpc, supabase } from "../lib/supabase.js";
import { ENV } from "../lib/env.js";
import { BOT_BIENVENIDA } from "./config.js";
import { BotSesion, SedeResumen, ServicioResumen, SlotResumen } from "./types.js";

// ──────────────────────────────────────────────────────────
// Helpers de formato
// ──────────────────────────────────────────────────────────

const DIAS  = ["Dom","Lun","Mar","Mié","Jue","Vie","Sáb"];
const MESES = ["","ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

function formatFecha(fecha: string): string {
  const d = new Date(fecha + "T12:00:00Z");
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} ${MESES[d.getUTCMonth() + 1]}`;
}

function toHoraRD(isoUtc: string): string {
  return new Date(isoUtc).toLocaleTimeString("es-DO", {
    timeZone: "America/Santo_Domingo",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
}

function fechaHoyRD(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Santo_Domingo" });
}

function ahoraRD(): Date {
  const now = new Date();
  const rdStr = now.toLocaleString("en-US", { timeZone: "America/Santo_Domingo" });
  return new Date(rdStr);
}

function validarTelefonoRD(tel: string): string | null {
  const digits = tel.replace(/\D/g, "");
  let numero = digits;
  if (numero.length === 11 && numero.startsWith("1")) numero = numero.slice(1);
  if (numero.length !== 10) return null;
  if (!["809","829","849"].includes(numero.slice(0, 3))) return null;
  return "+1" + numero;
}

// ──────────────────────────────────────────────────────────
// Consultas a Supabase
// ──────────────────────────────────────────────────────────

async function buscarDoctor(texto: string): Promise<any | null> {
  const clean = texto.trim();
  if (!clean || clean.length < 2) return null;

  // Buscar por extensión (solo números)
  if (/^\d+$/.test(clean)) {
    const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${clean}`,
      activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    console.log(`[buscarDoctor] extension="${clean}" status=${res.status} encontrado=${!!res.data?.[0]}`);
    if (Array.isArray(res.data) && res.data[0]) return res.data[0];
  }

  // Buscar por nombre o apellido (ilike = case insensitive)
  // IMPORTANTE: PostgREST requiere paréntesis en el filtro or: (cond1,cond2)
  const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `(nombre.ilike.*${clean}*,apellido.ilike.*${clean}*)`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });

  console.log(`[buscarDoctor] query="${clean}" status=${res.status} resultados=${Array.isArray(res.data) ? res.data.length : "ERROR: " + JSON.stringify(res.data)}`);

  if (!res.data || !Array.isArray(res.data) || res.data.length === 0) return null;
  if (res.data.length === 1) return res.data[0];
  return { multiples: res.data };
}

/** Intenta buscar doctor con múltiples variantes del texto */
async function buscarDoctorAgresivo(texto: string): Promise<any | null> {
  console.log(`[buscarDoctorAgresivo] texto original: "${texto}"`);

  // 1. Intentar con texto completo limpio
  const limpio = texto.replace(/[^a-záéíóúñü\s\d]/gi, "").trim();
  console.log(`[buscarDoctorAgresivo] intentando texto limpio: "${limpio}"`);
  let resultado = await buscarDoctor(limpio);
  if (resultado) return resultado;

  // 2. Intentar cada palabra de 3+ caracteres (nombres propios)
  const palabras = limpio.split(/\s+/).filter(p => p.length >= 3);
  for (const palabra of palabras) {
    const skip = ["que","quien","quién","cual","cuál","como","cómo","con","por","para",
      "los","las","del","una","uno","ese","esa","doctor","doctora","dra","quiero",
      "busca","buscar","deseo","necesito","tiene","tiene","donde","esta","nombre",
      "extension","consulta","cita","agendar","ver","saber","información","info",
      "favor","puede","podria","quiere","tiene","hola","buenas","buenos","dias"];
    if (skip.includes(palabra.toLowerCase())) continue;
    console.log(`[buscarDoctorAgresivo] intentando palabra: "${palabra}"`);
    resultado = await buscarDoctor(palabra);
    if (resultado) return resultado;
  }

  console.log(`[buscarDoctorAgresivo] no se encontró nada`);
  return null;
}

async function buscarSedes(doctorId: string): Promise<SedeResumen[]> {
  const res = await supabase<SedeResumen[]>("GET", "/rest/v1/doctor_clinica", null, {
    doctor_id: `eq.${doctorId}`,
    activo: "eq.true",
    select: "id,clinicas(nombre,ciudad,direccion,telefono)",
  });
  return res.data ?? [];
}

async function buscarServicios(dcId: string): Promise<ServicioResumen[]> {
  const res = await supabase<ServicioResumen[]>("GET", "/rest/v1/servicios", null, {
    doctor_clinica_id: `eq.${dcId}`,
    activo: "eq.true",
    invisible_para_pacientes: "eq.false",
    select: "id,nombre,duracion_min,tipo",
  });
  return res.data ?? [];
}

async function buscarSlots(dcId: string, srvId: string, fecha: string): Promise<{texto: string; slots: SlotResumen[]}> {
  const result = await rpc<any>("fn_slots_con_espacio", {
    p_doctor_clinica_id: dcId,
    p_fecha: fecha,
    p_servicio_id: srvId,
  });

  const hoy = fechaHoyRD();
  const ahora = ahoraRD();

  // Filtrar slots que ya pasaron si la fecha es HOY
  const rawSlots = result.data ?? [];
  const filtrados = rawSlots.filter((s: any) => {
    if (fecha !== hoy) return true;
    const slotTime = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
    return slotTime > ahora;
  });

  const slots: SlotResumen[] = filtrados.slice(0, 8).map((s: any, i: number) => ({
    num: i + 1,
    hora: toHoraRD(s.inicia_en),
    inicia_en: s.inicia_en,
  }));

  if (slots.length === 0) return { texto: "No hay horarios disponibles para ese día.", slots: [] };
  const texto = slots.map(s => `${s.num}. ${s.hora}`).join("\n");
  return { texto, slots };
}

async function agendarCita(sesion: BotSesion, slot: SlotResumen): Promise<string | null> {
  const nombreParts = (sesion.nombre ?? "Paciente").split(" ");
  const pac = await rpc<any>("fn_get_or_create_paciente", {
    p_telefono: sesion.telefono ?? "",
    p_nombre: nombreParts[0] ?? "Paciente",
    p_apellido: nombreParts.slice(1).join(" ") || "Paciente",
    p_cedula: null, p_fecha_nacimiento: null, p_sexo: null, p_zona: null,
  });
  if (!pac.data?.[0]?.paciente_id) return null;

  const cita = await rpc<any>("fn_agendar_cita", {
    p_doctor_clinica_id: sesion.sede_id,
    p_paciente_id: pac.data[0].paciente_id,
    p_servicio_id: sesion.servicio_id,
    p_inicia_en: slot.inicia_en,
    p_motivo: sesion.motivo ?? "Consulta medica",
    p_canal: "telegram",
    p_creado_por: null,
  });

  if (!cita.data?.[0]?.exito) return null;
  return cita.data[0].codigo;
}

// ──────────────────────────────────────────────────────────
// System prompt para Claude
// ──────────────────────────────────────────────────────────

function buildSystemPrompt(sesion: BotSesion, contexto: string): string {
  const hoy = fechaHoyRD();
  const ahora = ahoraRD();
  const horaActual = ahora.toLocaleTimeString("es-DO", { hour: "numeric", minute: "2-digit", hour12: true });

  return `Eres la recepcionista virtual de CitasMed RD, un sistema de agendamiento de citas médicas.
Tu nombre es Asistente CitasMed. Profesional, cálida, directa. Sin emojis.
Máximo 4 líneas por respuesta. Tono clínico y humano.

HOY: ${hoy} | HORA ACTUAL RD: ${horaActual}

═══ INFORMACIÓN REAL DEL SISTEMA ═══
${contexto}
═══ FIN INFORMACIÓN ═══

ESTADO DEL PACIENTE:
- Doctor: ${sesion.doctor_nombre ?? "NO IDENTIFICADO"}
- Sede: ${sesion.sede_nombre ?? "no seleccionada"}
- Tipo consulta: ${sesion.es_primera === undefined ? "no definido" : sesion.es_primera ? "Primera vez" : "Seguimiento"}
- Nombre: ${sesion.nombre ?? "pendiente"}
- Teléfono: ${sesion.telefono ?? "pendiente"}
- Motivo: ${sesion.motivo ?? "pendiente"}
- Horarios mostrados: ${sesion.slots_disponibles ?? "ninguno"}

REGLAS ABSOLUTAS:
1. SOLO responde con la información entre ═══. JAMÁS inventes datos.
2. Si la info de sedes incluye dirección y teléfono, DÁSELA al paciente cuando pregunte.
3. Teléfonos dominicanos: 10 dígitos, 809/829/849.
4. No motivos no médicos.
5. Cuando tengas: sede + tipo consulta + nombre + teléfono + motivo → pon [BUSCAR_SLOTS].
6. Para cancelar: pide código → pon [CANCELAR codigo=XXXX].
7. NUNCA muestres [BUSCAR_SLOTS] ni [CANCELAR] como texto al paciente.
8. Tono: "Con gusto", "Perfecto", "Me permite", "Le reservo".`;
}

// ──────────────────────────────────────────────────────────
// Extracción de datos con Claude
// ──────────────────────────────────────────────────────────

async function extraerDatos(texto: string): Promise<any> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 200,
      system: `Extrae datos del mensaje de un paciente que quiere agendar cita médica. Responde SOLO JSON puro sin markdown.

Campos posibles:
- nombre: string (nombre completo del PACIENTE, no del doctor)
- telefono: string (solo dígitos, mínimo 10)
- motivo: string (SOLO si es médico: dolor, chequeo, síntoma, bulto, sangrado, etc.)
- es_primera: boolean (true=primera vez, false=seguimiento/control)
- provincia: string (ciudad/lugar donde quiere la cita)
- sede_numero: number (si el paciente elige sede por número: 1, 2, 3...)

IMPORTANTE: NO extraigas "doctor_busqueda" — la búsqueda de doctor se hace por otro medio.
Solo incluye campos que encuentres claramente. Si no hay nada, devuelve {}`,
      messages: [{ role: "user", content: texto }],
    }),
  });
  try {
    const data = await res.json() as { content?: { text?: string }[] };
    const text = data.content?.[0]?.text?.trim() ?? "{}";
    return JSON.parse(text.replace(/```json|```/g, "").trim());
  } catch { return {}; }
}

async function llamarClaude(historial: {role: string; content: string}[], system: string): Promise<string> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ENV.CLAUDE_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      system,
      messages: historial,
    }),
  });
  if (!res.ok) return "Disculpe, tuve un problema técnico. Puede repetir?";
  const data = await res.json() as { content?: { text?: string }[] };
  return data.content?.[0]?.text?.trim() ?? "Disculpe, no pude procesar su mensaje.";
}

// ──────────────────────────────────────────────────────────
// Construir contexto REAL desde la base de datos
// ──────────────────────────────────────────────────────────

function buildContexto(sesion: BotSesion): string {
  let ctx = "";

  if (sesion.doctor_nombre) {
    ctx += `Doctor: ${sesion.doctor_nombre}`;
    if (sesion.doctor_extension) ctx += ` (ext. ${sesion.doctor_extension})`;
    ctx += "\n";
  }

  if (sesion.sedes_disponibles && sesion.sedes_disponibles.length > 0) {
    ctx += "Sedes disponibles:\n";
    ctx += sesion.sedes_disponibles.map((s, i) => {
      let linea = `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`;
      if (s.clinicas?.direccion) linea += `\n   Dirección: ${s.clinicas.direccion}`;
      if (s.clinicas?.telefono) linea += `\n   Teléfono: ${s.clinicas.telefono}`;
      return linea;
    }).join("\n");
    ctx += "\n";
  }

  if (sesion.servicios_disponibles && sesion.servicios_disponibles.length > 0) {
    ctx += "Servicios en esta sede:\n";
    ctx += sesion.servicios_disponibles.map(s => `- ${s.nombre} (${s.duracion_min} min)`).join("\n");
    ctx += "\n";
  }

  if (!ctx) {
    ctx = "No hay doctor identificado. Esperando que el paciente indique nombre o extensión.";
  }

  return ctx;
}

// ──────────────────────────────────────────────────────────
// Helpers para identificar al doctor
// ──────────────────────────────────────────────────────────

/** Formatea la info del doctor recién encontrado para mostrar al paciente */
function formatDoctorEncontrado(doc: any, sedes: SedeResumen[]): string {
  const especialidades = (doc.especialidades ?? [])
    .map((e: any) => e.especialidades?.nombre)
    .filter(Boolean)
    .join(", ");

  let msg = `He identificado al Dr. ${doc.nombre} ${doc.apellido}`;
  if (especialidades) msg += ` — ${especialidades}`;
  if (doc.extension) msg += ` (ext. ${doc.extension})`;
  msg += ".\n";

  if (sedes.length === 1) {
    const s = sedes[0]!;
    msg += `\nAtiende en: ${s.clinicas?.nombre}, ${s.clinicas?.ciudad}.`;
    if (s.clinicas?.direccion) msg += `\nDirección: ${s.clinicas.direccion}`;
    if (s.clinicas?.telefono) msg += `\nTeléfono: ${s.clinicas.telefono}`;
    msg += `\n\n¿Es esta su primera consulta con el doctor, o viene por seguimiento?`;
  } else if (sedes.length > 1) {
    msg += `\nAtiende en las siguientes sedes:\n`;
    msg += sedes.map((s, i) => {
      let linea = `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`;
      if (s.clinicas?.telefono) linea += ` — Tel: ${s.clinicas.telefono}`;
      return linea;
    }).join("\n");
    msg += `\n\n¿En cuál sede desea ser atendido?`;
  }

  return msg;
}

// ──────────────────────────────────────────────────────────
// Flujo principal
// ──────────────────────────────────────────────────────────

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const historial: {role: string; content: string}[] = sesion.historial ?? [];

  const tl = texto.toLowerCase().trim();

  // ── Saludo / reset ──
  const esSaludo = texto === "/start" || ["hola","buenas","buenos dias","buenas tardes","buenas noches","inicio"].includes(tl);
  if (esSaludo) {
    await deleteSesion(chatId);
    sesion = {};
    historial.length = 0;
    historial.push({ role: "assistant", content: BOT_BIENVENIDA });
    sesion.historial = historial;
    await setSesion(chatId, sesion);
    await enviar(chatId, BOT_BIENVENIDA);
    return;
  }

  // ── Extraer datos del paciente (nombre, teléfono, motivo — NO doctor) ──
  const datos = await extraerDatos(texto);

  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;
  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) sesion.es_primera = datos.es_primera;

  // Detección directa de tipo de consulta (no depender de Haiku)
  if (sesion.es_primera === undefined) {
    const palabrasPrimera = ["primera","primera vez","primer consulta","primera consulta","nuevo","nueva"];
    const palabrasSeguimiento = ["seguimiento","control","revision","revisión","chequeo","segunda"];
    if (palabrasPrimera.some(p => tl.includes(p))) {
      sesion.es_primera = true;
      console.log(`[Detección directa] es_primera=true por texto: "${tl}"`);
    } else if (palabrasSeguimiento.some(p => tl.includes(p))) {
      sesion.es_primera = false;
      console.log(`[Detección directa] es_primera=false por texto: "${tl}"`);
    }
  }

  if (datos.telefono && !sesion.telefono) {
    const telValido = validarTelefonoRD(datos.telefono);
    if (telValido) sesion.telefono = telValido;
  }

  // ══════════════════════════════════════════════════════════
  // BÚSQUEDA DE DOCTOR — DIRECTO EN SUPABASE, SIN DEPENDER DE HAIKU
  // ══════════════════════════════════════════════════════════

  if (!sesion.doctor_id && !sesion.doctores_multiples) {
    // Buscar agresivamente en la DB con el texto del paciente
    const resultado = await buscarDoctorAgresivo(texto);

    if (resultado && resultado.multiples) {
      // Múltiples doctores encontrados
      const lista = resultado.multiples.map((d: any, i: number) =>
        `${i + 1}. Dr. ${d.nombre} ${d.apellido}${d.extension ? ` (ext. ${d.extension})` : ""}`
      ).join("\n");
      historial.push({ role: "user", content: texto });
      const resp = `Encontré varios doctores:\n\n${lista}\n\nPor favor indique el número o la extensión del doctor que busca.`;
      historial.push({ role: "assistant", content: resp });
      sesion.doctores_multiples = resultado.multiples;
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;

    } else if (resultado && !resultado.multiples) {
      // Doctor único encontrado — cargar sus sedes y mostrar info
      sesion.doctor_id = resultado.id;
      sesion.doctor_nombre = `Dr. ${resultado.nombre} ${resultado.apellido}`;
      if (resultado.extension) sesion.doctor_extension = resultado.extension;

      // IMPORTANTE: si extraerDatos guardó el nombre del doctor como nombre del paciente, borrarlo
      if (sesion.nombre) {
        const nombreDoc = resultado.nombre.toLowerCase();
        const apellidoDoc = resultado.apellido.toLowerCase();
        const nombrePac = sesion.nombre.toLowerCase();
        if (nombrePac === nombreDoc || nombrePac === apellidoDoc || 
            nombrePac === `${nombreDoc} ${apellidoDoc}`) {
          console.log(`[Nombre] Limpiando nombre del paciente "${sesion.nombre}" — coincide con el doctor`);
          delete sesion.nombre;
        }
      }

      const sedes = await buscarSedes(resultado.id);
      sesion.sedes_disponibles = sedes;

      // Auto-seleccionar si solo hay 1 sede
      if (sedes.length === 1) {
        const unica = sedes[0]!;
        sesion.sede_id = unica.id;
        sesion.sede_nombre = `${unica.clinicas?.nombre} (${unica.clinicas?.ciudad})`;
        sesion.servicios_disponibles = await buscarServicios(unica.id);
      }

      const resp = formatDoctorEncontrado(resultado, sedes);
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;

    } else {
      // No encontrado en la DB
      historial.push({ role: "user", content: texto });
      const resp = "No encontré un doctor con ese nombre o extensión en nuestro sistema. ¿Podría verificar el nombre completo o el número de extensión?";
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  // ── Selección de doctor múltiple por número ──
  if (!sesion.doctor_id && sesion.doctores_multiples) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.doctores_multiples.length) {
      const doc = sesion.doctores_multiples[num]!;
      sesion.doctor_id = doc.id;
      sesion.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
      if (doc.extension) sesion.doctor_extension = doc.extension;
      const sedes = await buscarSedes(doc.id);
      sesion.sedes_disponibles = sedes;
      delete sesion.doctores_multiples;

      if (sedes.length === 1) {
        const unica = sedes[0]!;
        sesion.sede_id = unica.id;
        sesion.sede_nombre = `${unica.clinicas?.nombre} (${unica.clinicas?.ciudad})`;
        sesion.servicios_disponibles = await buscarServicios(unica.id);
      }

      const resp = formatDoctorEncontrado(doc as any, sedes);
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
    // Si no es un número válido, intentar buscar de nuevo
    const resultado = await buscarDoctorAgresivo(texto);
    if (resultado && !resultado.multiples) {
      sesion.doctor_id = resultado.id;
      sesion.doctor_nombre = `Dr. ${resultado.nombre} ${resultado.apellido}`;
      if (resultado.extension) sesion.doctor_extension = resultado.extension;
      const sedes = await buscarSedes(resultado.id);
      sesion.sedes_disponibles = sedes;
      delete sesion.doctores_multiples;

      if (sedes.length === 1) {
        const unica = sedes[0]!;
        sesion.sede_id = unica.id;
        sesion.sede_nombre = `${unica.clinicas?.nombre} (${unica.clinicas?.ciudad})`;
        sesion.servicios_disponibles = await buscarServicios(unica.id);
      }

      const resp = formatDoctorEncontrado(resultado, sedes);
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  // ── Selección de sede por número, nombre de clínica, o ciudad ──
  if (sesion.doctor_id && !sesion.sede_id && sesion.sedes_disponibles) {
    const sedes = sesion.sedes_disponibles;
    const num = parseInt(texto) - 1;
    let sedeElegida: SedeResumen | undefined;

    if (!isNaN(num) && num >= 0 && num < sedes.length) {
      // Por número: "2"
      sedeElegida = sedes[num];
    } else {
      // Por texto: matchear contra NOMBRE de clínica Y ciudad
      const textoLow = tl; // ya calculado arriba como texto.toLowerCase().trim()
      sedeElegida = sedes.find(s => {
        const nombre = s.clinicas?.nombre?.toLowerCase() ?? "";
        const ciudad = s.clinicas?.ciudad?.toLowerCase() ?? "";
        // Match si el texto aparece en el nombre de la clínica
        if (nombre.includes(textoLow)) return true;
        if (textoLow.includes(nombre)) return true;
        // Match parcial: "maría dolores" en "centro médico maría dolores"
        const palabrasTexto = textoLow.split(/\s+/).filter(p => p.length >= 3);
        if (palabrasTexto.length > 0 && palabrasTexto.every(p => nombre.includes(p))) return true;
        // Match por ciudad
        if (ciudad.includes(textoLow)) return true;
        if (textoLow.includes(ciudad)) return true;
        // Match por provincia (si Haiku la extrajo)
        if (datos.provincia) {
          if (ciudad.includes(datos.provincia.toLowerCase())) return true;
          if (nombre.includes(datos.provincia.toLowerCase())) return true;
        }
        return false;
      });
    }

    if (sedeElegida) {
      sesion.sede_id = sedeElegida.id;
      sesion.sede_nombre = `${sedeElegida.clinicas?.nombre} (${sedeElegida.clinicas?.ciudad})`;
      sesion.servicios_disponibles = await buscarServicios(sedeElegida.id);
      console.log(`[Sede] Seleccionada: ${sesion.sede_nombre} por texto: "${texto}"`);

      // Confirmar sede y preguntar tipo de consulta
      let resp = `Perfecto. ${sesion.sede_nombre}.`;
      if (sedeElegida.clinicas?.direccion) resp += `\nDirección: ${sedeElegida.clinicas.direccion}`;
      if (sedeElegida.clinicas?.telefono) resp += `\nTeléfono: ${sedeElegida.clinicas.telefono}`;
      resp += `\n\n¿Es esta su primera consulta con el doctor, o viene por seguimiento/control?`;
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  // ── Resolver servicio si tenemos sede + tipo ──
  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    const servicios = sesion.servicios_disponibles ?? [];
    const srv = sesion.es_primera
      ? servicios.find(s => s.tipo === "primera_vez") ?? servicios[0]
      : servicios.find(s => s.tipo === "normal" || s.tipo === "rapida") ?? servicios[0];
    if (srv) {
      sesion.servicio_id = srv.id;
      console.log(`[Servicio] Auto-seleccionado: ${srv.nombre} (${srv.tipo}) para es_primera=${sesion.es_primera}`);
    }
  }

  // ── Fallback: si tenemos todos los datos MENOS servicio, elegir el primero disponible ──
  if (sesion.sede_id && !sesion.servicio_id && sesion.nombre && sesion.telefono && sesion.motivo) {
    const servicios = sesion.servicios_disponibles ?? [];
    const srv = servicios.find(s => s.tipo === "normal") ?? servicios[0];
    if (srv) {
      sesion.servicio_id = srv.id;
      console.log(`[Servicio] Fallback: ${srv.nombre} (${srv.tipo}) — es_primera no fue detectado`);
    }
  }

  // ── Eligiendo día por número ──
  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.dias_disponibles.length) {
      const fechaSel = sesion.dias_disponibles[num]!.fecha;
      const { texto: slotsTexto, slots } = await buscarSlots(sesion.sede_id!, sesion.servicio_id!, fechaSel);

      if (slots.length === 0) {
        historial.push({ role: "user", content: texto });
        const resp = "Ya no quedan horarios disponibles para ese día. Por favor seleccione otro.";
        historial.push({ role: "assistant", content: resp });
        sesion.historial = historial.slice(-20);
        await setSesion(chatId, sesion);
        await enviar(chatId, resp);
        return;
      }

      sesion.fecha_sel = fechaSel;
      sesion.slots = slots;
      sesion.slots_disponibles = slotsTexto;
      sesion.paso = "elegir_hora";
      const resp = `Para el ${formatFecha(fechaSel)} tengo los siguientes horarios:\n\n${slotsTexto}\n\n¿Cuál prefiere?`;
      historial.push({ role: "user", content: texto });
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }
  }

  // ── Eligiendo hora por número ──
  if (sesion.paso === "elegir_hora" && sesion.slots && sesion.nombre && sesion.telefono) {
    const num = parseInt(texto) - 1;
    let slotElegido: SlotResumen | undefined;

    if (!isNaN(num) && num >= 0 && num < sesion.slots.length) {
      slotElegido = sesion.slots[num];
    } else {
      const textoNorm = texto.toLowerCase().replace(/\s/g, "").replace(".", ":");
      slotElegido = sesion.slots.find(s => {
        const horaNorm = s.hora.toLowerCase().replace(/\s/g, "");
        return horaNorm.includes(textoNorm) || textoNorm.includes(horaNorm.replace(":00","").replace(":30",""));
      });
    }

    if (slotElegido) {
      // Verificar que no haya pasado mientras decidía
      const hoy = fechaHoyRD();
      if (sesion.fecha_sel === hoy) {
        const ahora = ahoraRD();
        const slotTime = new Date(new Date(slotElegido.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
        if (slotTime <= ahora) {
          await enviar(chatId, "Ese horario ya pasó. Por favor seleccione otro o escriba /start para comenzar de nuevo.");
          return;
        }
      }

      const codigo = await agendarCita(sesion, slotElegido);
      await deleteSesion(chatId);
      if (!codigo) {
        await enviar(chatId, "Ese horario ya no está disponible. Escriba /start para seleccionar otro.");
        return;
      }
      await enviar(chatId,
        `Cita reservada correctamente.\n\n` +
        `Doctor: ${sesion.doctor_nombre}\n` +
        `Fecha: ${formatFecha(sesion.fecha_sel!)}\n` +
        `Hora: ${slotElegido.hora}\n` +
        `Paciente: ${sesion.nombre}\n` +
        `Sede: ${sesion.sede_nombre}\n` +
        `Código: ${codigo}\n\n` +
        `Guarde este código. Si necesita cancelar, envíelo aquí o escriba /cancelar.`
      );
      return;
    }
  }

  // ══════════════════════════════════════════════════════════
  // AUTO-TRIGGER: Buscar disponibilidad cuando TODOS los datos están completos
  // No depender de que Claude escriba [BUSCAR_SLOTS]
  // ══════════════════════════════════════════════════════════
  console.log(`[Estado] sede=${!!sesion.sede_id} srv=${!!sesion.servicio_id} nombre=${!!sesion.nombre} tel=${!!sesion.telefono} motivo=${!!sesion.motivo} paso=${sesion.paso ?? "ninguno"}`);

  if (sesion.sede_id && sesion.servicio_id && sesion.nombre && sesion.telefono && sesion.motivo
      && sesion.paso !== "elegir_dia" && sesion.paso !== "elegir_hora") {

    console.log("[AUTO-TRIGGER] Todos los datos completos, buscando disponibilidad...");

    const diasResult = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: sesion.sede_id,
      p_servicio_id: sesion.servicio_id,
      p_dias_adelante: 14,
      p_max_resultados: 5,
    });

    let dias = diasResult.data ?? [];
    const hoy = fechaHoyRD();
    dias = dias.filter((d: any) => d.fecha >= hoy);

    historial.push({ role: "user", content: texto });

    if (dias.length === 0) {
      const resp = `Tengo sus datos completos:\n${sesion.nombre} | ${sesion.sede_nombre} | ${sesion.motivo}\n\nLamentablemente no hay citas disponibles en los próximos 14 días. Puede intentar con otra sede o llamar directamente.`;
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }

    sesion.dias_disponibles = dias;
    sesion.paso = "elegir_dia";
    const lista = dias.map((d: any, i: number) =>
      `${i + 1}. ${formatFecha(d.fecha)} — ${d.total_slots} horarios disponibles`
    ).join("\n");
    const resp = `Perfecto. Tengo sus datos:\n${sesion.nombre} | ${sesion.sede_nombre} | ${sesion.motivo}\n\nDías disponibles:\n\n${lista}\n\n¿Para qué día le reservo?`;
    historial.push({ role: "assistant", content: resp });
    sesion.historial = historial.slice(-20);
    await setSesion(chatId, sesion);
    await enviar(chatId, resp);
    return;
  }

  // ── Construir contexto REAL y delegar a Claude ──
  const contexto = buildContexto(sesion);
  historial.push({ role: "user", content: texto });
  const system = buildSystemPrompt(sesion, contexto);
  let respuesta = await llamarClaude(historial, system);

  // ── Procesar [BUSCAR_SLOTS] ──
  if (respuesta.includes("[BUSCAR_SLOTS]") && sesion.sede_id && sesion.servicio_id) {
    respuesta = respuesta.replace("[BUSCAR_SLOTS]", "").trim();
    const diasResult = await rpc<any>("fn_dias_disponibles", {
      p_doctor_clinica_id: sesion.sede_id,
      p_servicio_id: sesion.servicio_id,
      p_dias_adelante: 14,
      p_max_resultados: 5,
    });

    let dias = diasResult.data ?? [];
    const hoy = fechaHoyRD();
    dias = dias.filter((d: any) => d.fecha >= hoy);

    if (dias.length === 0) {
      respuesta += "\n\nNo hay citas disponibles en los próximos 14 días. Puede intentar con otra sede.";
    } else {
      sesion.dias_disponibles = dias;
      sesion.paso = "elegir_dia";
      const lista = dias.map((d: any, i: number) =>
        `${i + 1}. ${formatFecha(d.fecha)} — ${d.total_slots} horarios disponibles`
      ).join("\n");
      respuesta += `\n\n${lista}\n\n¿Para qué día le reservo?`;
    }
  }

  // ── Procesar [CANCELAR codigo=XXX] ──
  const matchCancelar = respuesta.match(/\[CANCELAR codigo=([A-Z0-9-]+)\]/);
  if (matchCancelar) {
    respuesta = respuesta.replace(matchCancelar[0], "").trim();
    let codigo = matchCancelar[1]!.toUpperCase();
    if (!codigo.startsWith("CITA-")) codigo = "CITA-" + codigo;
    const found = await supabase<any[]>("GET", "/rest/v1/citas", null, {
      codigo: `eq.${codigo}`, select: "id,estado", limit: "1",
    });
    if (found.data?.[0] && ["pendiente","confirmada"].includes(found.data[0].estado)) {
      await rpc<any>("fn_cancelar_cita", {
        p_cita_id: found.data[0].id,
        p_motivo_cancel: "cancelada_paciente",
        p_cancelado_por: null,
        p_penalizar_paciente: null,
      });
      respuesta += `\n\nCita ${codigo} cancelada correctamente.`;
      await deleteSesion(chatId);
    } else {
      respuesta += `\n\nNo se encontró una cita activa con el código ${codigo}.`;
    }
  }

  // Limpiar tags internos que Claude haya dejado visibles
  respuesta = respuesta.replace(/\[BUSCAR_SLOTS\]/g, "").replace(/\[CANCELAR[^\]]*\]/g, "").trim();

  historial.push({ role: "assistant", content: respuesta });
  sesion.historial = historial.slice(-20);
  await setSesion(chatId, sesion);
  await enviar(chatId, respuesta);
}
