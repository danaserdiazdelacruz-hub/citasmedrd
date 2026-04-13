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

/** Devuelve el timestamp actual en zona RD como Date */
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

  // Buscar por extensión (solo números)
  if (/^\d+$/.test(clean)) {
    const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
      extension: `eq.${clean}`,
      activo: "eq.true",
      select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
      limit: "1",
    });
    if (res.data?.[0]) return res.data[0];
  }

  // Buscar por nombre o apellido
  const res = await supabase<any[]>("GET", "/rest/v1/doctores", null, {
    activo: "eq.true",
    or: `nombre.ilike.*${clean}*,apellido.ilike.*${clean}*`,
    select: "id,nombre,apellido,extension,especialidades:doctor_especialidad(especialidades(nombre))",
    limit: "5",
  });

  if (!res.data || res.data.length === 0) return null;
  if (res.data.length === 1) return res.data[0];
  return { multiples: res.data };
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

  // *** FIX PRINCIPAL: Filtrar slots que ya pasaron si la fecha es HOY ***
  const rawSlots = result.data ?? [];
  const filtrados = rawSlots.filter((s: any) => {
    if (fecha !== hoy) return true; // Solo filtra si es hoy
    // Comparar la hora del slot con la hora actual en RD
    const slotTime = new Date(new Date(s.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
    return slotTime > ahora;
  });

  const slots: SlotResumen[] = filtrados.slice(0, 8).map((s: any, i: number) => ({
    num: i + 1,
    hora: toHoraRD(s.inicia_en),
    inicia_en: s.inicia_en,
  }));

  if (slots.length === 0) return { texto: "No hay horarios disponibles para ese dia.", slots: [] };
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

  return `Eres la recepcionista virtual de la Red de Unidades Oncológicas.
Tu nombre es Asistente CitasMed. Profesional, cálida, directa. Sin emojis.
Máximo 4 líneas por respuesta. Tono clínico y humano a la vez.
Especialidad: Consultas de Ginecología y Oncología.

HOY: ${hoy} | HORA ACTUAL RD: ${horaActual}

═══ INFORMACION REAL DEL SISTEMA ═══
${contexto}
═══ FIN INFORMACION ═══

ESTADO DEL PACIENTE:
- Doctor: ${sesion.doctor_nombre ?? "NO IDENTIFICADO — debes preguntar nombre o extensión"}
- Sede: ${sesion.sede_nombre ?? "no seleccionada"}
- Tipo consulta: ${sesion.es_primera === undefined ? "no definido" : sesion.es_primera ? "Primera vez" : "Seguimiento"}
- Nombre: ${sesion.nombre ?? "pendiente"}
- Teléfono: ${sesion.telefono ?? "pendiente"}
- Motivo: ${sesion.motivo ?? "pendiente"}
- Horarios mostrados: ${sesion.slots_disponibles ?? "ninguno"}

REGLAS ESTRICTAS:
1. SOLO usa información que aparece arriba entre ═══. NUNCA inventes horarios, direcciones, teléfonos, servicios ni datos.
2. Si el paciente pregunta dirección, teléfono o ubicación de una sede, SOLO responde con lo que está en la información del sistema. Si no aparece, di que no tienes esa información disponible.
3. Si el doctor NO está identificado, tu UNICA tarea es preguntar con qué doctor o extensión desea comunicarse.
4. Teléfonos dominicanos: 10 dígitos, inician con 809, 829 o 849.
5. No aceptes motivos no médicos. Pide el motivo clínico real.
6. Cuando tengas sede + tipo de consulta + nombre + teléfono + motivo: incluye [BUSCAR_SLOTS] en tu respuesta.
7. Para cancelar: pide código y luego incluye [CANCELAR codigo=XXXX].
8. Usa: "Con gusto", "Perfecto", "Me permite", "Le reservo", "Enseguida".
9. NUNCA menciones [BUSCAR_SLOTS] ni [CANCELAR] como texto visible al paciente. Son comandos internos.
10. Si el paciente saluda sin dar info del doctor, responde con el saludo formal y pregunta con qué doctor o extensión desea ser atendido.`;
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
      system: `Extrae datos del mensaje del paciente. Responde SOLO JSON sin explicaciones ni markdown.
Campos posibles:
- nombre: string (nombre completo de persona real, no apodos)
- telefono: string (solo dígitos, mínimo 10)
- motivo: string (SOLO si es claramente médico: dolor, chequeo, síntoma, enfermedad, seguimiento, bulto, sangrado, etc.)
- es_primera: boolean (true=primera vez/primera consulta, false=seguimiento/control/revisión)
- provincia: string (si menciona lugar/ciudad donde quiere la cita)
- doctor_busqueda: string (nombre, apellido o extensión del doctor que busca)
Solo incluye campos que encuentres claramente en el texto. Si no hay nada, devuelve {}.`,
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
    ctx += `Doctor identificado: ${sesion.doctor_nombre}`;
    if (sesion.doctor_extension) ctx += ` (ext. ${sesion.doctor_extension})`;
    ctx += "\n";
  }

  if (sesion.sedes_disponibles && sesion.sedes_disponibles.length > 0) {
    ctx += "Sedes disponibles del doctor:\n";
    ctx += sesion.sedes_disponibles.map((s, i) => {
      let linea = `${i + 1}. ${s.clinicas?.nombre} — ${s.clinicas?.ciudad}`;
      if (s.clinicas?.direccion) linea += `\n   Dirección: ${s.clinicas.direccion}`;
      if (s.clinicas?.telefono) linea += `\n   Teléfono: ${s.clinicas.telefono}`;
      return linea;
    }).join("\n");
    ctx += "\n";
  }

  if (sesion.servicios_disponibles && sesion.servicios_disponibles.length > 0) {
    ctx += "Servicios disponibles en esta sede:\n";
    ctx += sesion.servicios_disponibles.map(s => `- ${s.nombre} (${s.duracion_min} min, tipo: ${s.tipo})`).join("\n");
    ctx += "\n";
  }

  if (!ctx) {
    ctx = "Doctor no identificado aún. El paciente debe indicar nombre o extensión del doctor.";
  }

  return ctx;
}

// ──────────────────────────────────────────────────────────
// Flujo principal
// ──────────────────────────────────────────────────────────

export async function procesarMensaje(chatId: string, texto: string): Promise<void> {
  let sesion = await getSesion(chatId);
  const historial: {role: string; content: string}[] = sesion.historial ?? [];

  const tl = texto.toLowerCase().trim();

  // ── Saludo / reset ──
  if (texto === "/start" || tl === "hola" || tl === "buenas" || tl === "buenos dias" || tl === "buenas tardes" || tl === "buenas noches" || tl === "inicio") {
    await deleteSesion(chatId);
    sesion = {};
    historial.length = 0;
    historial.push({ role: "assistant", content: BOT_BIENVENIDA });
    sesion.historial = historial;
    await setSesion(chatId, sesion);
    await enviar(chatId, BOT_BIENVENIDA);
    return;
  }

  // ── Extraer datos del mensaje ──
  const datos = await extraerDatos(texto);

  if (datos.nombre && !sesion.nombre) sesion.nombre = datos.nombre;
  if (datos.motivo && !sesion.motivo) sesion.motivo = datos.motivo;
  if (datos.es_primera !== undefined && sesion.es_primera === undefined) sesion.es_primera = datos.es_primera;

  if (datos.telefono && !sesion.telefono) {
    const telValido = validarTelefonoRD(datos.telefono);
    if (telValido) sesion.telefono = telValido;
  }

  // ── Buscar doctor si no está identificado ──
  if (!sesion.doctor_id && datos.doctor_busqueda) {
    const resultado = await buscarDoctor(datos.doctor_busqueda);

    if (!resultado) {
      historial.push({ role: "user", content: texto });
      const resp = "No encontré ese doctor en nuestro sistema. Por favor verifique el nombre completo o la extensión e inténtelo nuevamente.";
      historial.push({ role: "assistant", content: resp });
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }

    if (resultado.multiples) {
      const lista = resultado.multiples.map((d: any, i: number) =>
        `${i + 1}. Dr. ${d.nombre} ${d.apellido}${d.extension ? ` (ext. ${d.extension})` : ""}`
      ).join("\n");
      historial.push({ role: "user", content: texto });
      const resp = `Encontré varios doctores:\n\n${lista}\n\nPor favor indique el número o la extensión para identificarlo.`;
      historial.push({ role: "assistant", content: resp });
      sesion.doctores_multiples = resultado.multiples;
      sesion.historial = historial.slice(-20);
      await setSesion(chatId, sesion);
      await enviar(chatId, resp);
      return;
    }

    // Doctor único encontrado
    sesion.doctor_id = resultado.id;
    sesion.doctor_nombre = `Dr. ${resultado.nombre} ${resultado.apellido}`;
    if (resultado.extension) sesion.doctor_extension = resultado.extension;
    sesion.sedes_disponibles = await buscarSedes(resultado.id);
  }

  // ── Selección de doctor múltiple por número ──
  if (!sesion.doctor_id && sesion.doctores_multiples) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.doctores_multiples.length) {
      const doc = sesion.doctores_multiples[num]!;
      sesion.doctor_id = doc.id;
      sesion.doctor_nombre = `Dr. ${doc.nombre} ${doc.apellido}`;
      if (doc.extension) sesion.doctor_extension = doc.extension;
      sesion.sedes_disponibles = await buscarSedes(doc.id);
      delete sesion.doctores_multiples;
    }
  }

  // ── Selección de sede por número o provincia ──
  if (sesion.doctor_id && !sesion.sede_id && sesion.sedes_disponibles) {
    const sedes = sesion.sedes_disponibles;

    // Si solo hay 1 sede, seleccionarla automáticamente
    if (sedes.length === 1) {
      const unica = sedes[0]!;
      sesion.sede_id = unica.id;
      sesion.sede_nombre = `${unica.clinicas?.nombre} (${unica.clinicas?.ciudad})`;
      sesion.servicios_disponibles = await buscarServicios(unica.id);
    } else {
      const num = parseInt(texto) - 1;
      let sedeElegida: SedeResumen | undefined;

      if (!isNaN(num) && num >= 0 && num < sedes.length) {
        sedeElegida = sedes[num];
      } else if (datos.provincia) {
        sedeElegida = sedes.find(s =>
          s.clinicas?.ciudad?.toLowerCase().includes(datos.provincia.toLowerCase()) ||
          datos.provincia.toLowerCase().includes(s.clinicas?.ciudad?.toLowerCase().split(" ")[0] ?? "")
        );
      }

      if (sedeElegida) {
        sesion.sede_id = sedeElegida.id;
        sesion.sede_nombre = `${sedeElegida.clinicas?.nombre} (${sedeElegida.clinicas?.ciudad})`;
        sesion.servicios_disponibles = await buscarServicios(sedeElegida.id);
      }
    }
  }

  // ── Resolver servicio si tenemos sede + tipo ──
  if (sesion.sede_id && sesion.es_primera !== undefined && !sesion.servicio_id) {
    const servicios = sesion.servicios_disponibles ?? [];
    const srv = sesion.es_primera
      ? servicios.find(s => s.tipo === "primera_vez") ?? servicios[0]
      : servicios.find(s => s.tipo === "normal" || s.tipo === "rapida") ?? servicios[0];
    if (srv) sesion.servicio_id = srv.id;
  }

  // ── Eligiendo día por número ──
  if (sesion.paso === "elegir_dia" && sesion.dias_disponibles) {
    const num = parseInt(texto) - 1;
    if (!isNaN(num) && num >= 0 && num < sesion.dias_disponibles.length) {
      const fechaSel = sesion.dias_disponibles[num]!.fecha;
      const { texto: slotsTexto, slots } = await buscarSlots(sesion.sede_id!, sesion.servicio_id!, fechaSel);

      if (slots.length === 0) {
        // Todos los horarios de hoy ya pasaron
        historial.push({ role: "user", content: texto });
        const resp = "Ya no quedan horarios disponibles para ese día. Por favor seleccione otro día.";
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
      // Intentar match por texto de hora
      const textoNorm = texto.toLowerCase().replace(/\s/g, "").replace(".", ":");
      slotElegido = sesion.slots.find(s => {
        const horaNorm = s.hora.toLowerCase().replace(/\s/g, "");
        return horaNorm.includes(textoNorm) || textoNorm.includes(horaNorm.replace(":00","").replace(":30",""));
      });
    }

    if (slotElegido) {
      // Verificar que el slot no haya pasado mientras el paciente decidía
      const hoy = fechaHoyRD();
      if (sesion.fecha_sel === hoy) {
        const ahora = ahoraRD();
        const slotTime = new Date(new Date(slotElegido.inicia_en).toLocaleString("en-US", { timeZone: "America/Santo_Domingo" }));
        if (slotTime <= ahora) {
          await enviar(chatId, "Ese horario ya pasó. Por favor seleccione otro horario o escriba /start para comenzar de nuevo.");
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

    // *** FIX: Filtrar días que ya pasaron ***
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

  // ── Limpiar cualquier tag interno que Claude haya dejado visible ──
  respuesta = respuesta.replace(/\[BUSCAR_SLOTS\]/g, "").replace(/\[CANCELAR[^\]]*\]/g, "").trim();

  historial.push({ role: "assistant", content: respuesta });
  sesion.historial = historial.slice(-20);
  await setSesion(chatId, sesion);
  await enviar(chatId, respuesta);
}
