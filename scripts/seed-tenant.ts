// scripts/seed-tenant.ts
// Crea el tenant de prueba completo en Supabase:
//   - 1 tenant: Red de Unidades Oncológicas
//   - 1 profesional: Dr. Hairol Pérez (Ginecología y Oncología)
//   - 3 sedes: María Dolores, Unidad Oncológica del Este, Doctor Paulino
//   - horarios L-V 8am-12pm + 1pm-5pm en cada sede (slot 20min, 3 cupos)
//   - 8 servicios en cada sede
//   - 1 canal Telegram conectado
//
// Idempotente: si ya existe, no duplica (busca por slug del tenant).
//
// Ejecutar:
//   npm run seed:tenant

import { getDb } from "../src/persistence/db.js";

// CONFIGURACIÓN — cambia BOT_USERNAME por el del bot real si es distinto
const TENANT_SLUG = "red-unidades-oncologicas";
const BOT_USERNAME = "maria_lab_bot";  // <-- AJUSTA si tu bot tiene otro username
const TIMEZONE = "America/Santo_Domingo";

const SEDES_CONFIG = [
  {
    nombre: "Centro Médico María Dolores",
    direccion: "Santo Domingo",
    ciudad: "Santo Domingo",
    telefono: "+18095478601",
  },
  {
    nombre: "Unidad Oncológica del Este",
    direccion: "San Pedro de Macorís",
    ciudad: "San Pedro de Macorís",
    telefono: "+18095294559",
  },
  {
    nombre: "Centro Médico Doctor Paulino",
    direccion: "Provincia Independencia",
    ciudad: "Independencia",
    telefono: "+18297082711",
  },
];

const SERVICIOS_CONFIG = [
  { codigo: "consulta_gineco_onco",   nombre: "Consulta Ginecología y Oncología", duracion: 20, precio: 2500 },
  { codigo: "citologia",              nombre: "Citología Exfoliativa",            duracion: 20, precio: 1500 },
  { codigo: "colposcopia_biopsia",    nombre: "Colposcopia con Biopsia",          duracion: 40, precio: 4500 },
  { codigo: "cono_asa",               nombre: "Cono Asa",                         duracion: 60, precio: 8000 },
  { codigo: "biopsia_mama",           nombre: "Biopsia de Mama Sonodirigida",     duracion: 40, precio: 6500 },
  { codigo: "consulta_oncologica",    nombre: "Consulta Oncológica / Asesoría",   duracion: 20, precio: 3000 },
  { codigo: "cirugia_laparoscopica",  nombre: "Cirugía Laparoscópica",            duracion: 120, precio: 25000 },
  { codigo: "manejo_hpv",             nombre: "Manejo de Patología Cervical (HPV)", duracion: 30, precio: 3500 },
];

async function main(): Promise<void> {
  const db = getDb();

  console.log("🌱 Sembrando tenant de prueba…\n");

  // 1. ¿Ya existe este tenant?
  const { data: existing } = await db
    .from("tenants")
    .select("id")
    .eq("slug", TENANT_SLUG)
    .maybeSingle();

  let tenantId: string;
  if (existing) {
    tenantId = existing.id;
    console.log(`   ℹ️  Tenant ya existe: ${tenantId}. Saltando creación, actualizando dependientes.`);
  } else {
    // Crear tenant
    const { data, error } = await db
      .from("tenants")
      .insert({
        nombre_comercial: "Red de Unidades Oncológicas",
        slug: TENANT_SLUG,
        tipo_entidad: "clinica",
        plan: "trial",
        estado: "activo",
        timezone: TIMEZONE,
        moneda: "DOP",
        pais: "DO",
      })
      .select("id")
      .single();

    if (error || !data) throw new Error(`No se pudo crear tenant: ${error?.message}`);
    tenantId = data.id;
    console.log(`   ✓ Tenant creado: ${tenantId}`);
  }

  // 2. Tipo profesional médico
  const { data: tipoMedico, error: e2 } = await db
    .from("tipos_profesional")
    .select("id")
    .eq("codigo", "medico")
    .single();
  if (e2 || !tipoMedico) throw new Error(`tipo_profesional 'medico' no existe — ¿corriste el 004?`);

  // 3. Profesional Dr. Hairol Pérez
  const { data: profExisting } = await db
    .from("profesionales")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("nombre", "Hairol")
    .eq("apellido", "Pérez")
    .maybeSingle();

  let profesionalId: string;
  if (profExisting) {
    profesionalId = profExisting.id;
    console.log(`   ℹ️  Profesional ya existe: ${profesionalId}`);
  } else {
    const { data, error } = await db
      .from("profesionales")
      .insert({
        tenant_id: tenantId,
        tipo_profesional_id: tipoMedico.id,
        prefijo: "Dr.",
        nombre: "Hairol",
        apellido: "Pérez",
        bio_corta: "Médico especialista en Ginecología y Oncología con experiencia en patología cervical, mamaria y cirugía laparoscópica.",
        anos_experiencia: 15,
        activo: true,
      })
      .select("id")
      .single();
    if (error || !data) throw new Error(`No se pudo crear profesional: ${error?.message}`);
    profesionalId = data.id;
    console.log(`   ✓ Profesional creado: Dr. Hairol Pérez (${profesionalId})`);
  }

  // 4. Asociar especialidades (Ginecología + Oncología)
  const { data: especialidades } = await db
    .from("especialidades")
    .select("id, codigo")
    .eq("tipo_profesional_id", tipoMedico.id)
    .in("codigo", ["ginecologia", "oncologia"]);

  if (especialidades && especialidades.length > 0) {
    for (const esp of especialidades) {
      await db
        .from("profesional_especialidad")
        .upsert({
          profesional_id: profesionalId,
          especialidad_id: esp.id,
          es_principal: esp.codigo === "ginecologia",
        });
    }
    console.log(`   ✓ Especialidades vinculadas: ${especialidades.map(e => e.codigo).join(", ")}`);
  }

  // 5. Crear las 3 sedes + profesional_sede + horarios + servicios
  for (const sedeConfig of SEDES_CONFIG) {
    // Sede
    const { data: sedeExist } = await db
      .from("sedes")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("nombre", sedeConfig.nombre)
      .maybeSingle();

    let sedeId: string;
    if (sedeExist) {
      sedeId = sedeExist.id;
    } else {
      const { data, error } = await db
        .from("sedes")
        .insert({
          tenant_id: tenantId,
          nombre: sedeConfig.nombre,
          direccion: sedeConfig.direccion,
          ciudad: sedeConfig.ciudad,
          telefono: sedeConfig.telefono,
          activo: true,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`Error creando sede ${sedeConfig.nombre}: ${error?.message}`);
      sedeId = data.id;
    }
    console.log(`   ✓ Sede: ${sedeConfig.nombre}`);

    // profesional_sede
    const { data: psExist } = await db
      .from("profesional_sede")
      .select("id")
      .eq("profesional_id", profesionalId)
      .eq("sede_id", sedeId)
      .maybeSingle();

    let psId: string;
    if (psExist) {
      psId = psExist.id;
    } else {
      const { data, error } = await db
        .from("profesional_sede")
        .insert({
          tenant_id: tenantId,
          profesional_id: profesionalId,
          sede_id: sedeId,
          slot_min: 20,
          cupos_por_slot: 3,
          buffer_entre_citas_min: 0,
          ventana_cancel_gratis_horas: 24,
          max_dias_reserva_adelanto: 60,
          activo: true,
        })
        .select("id")
        .single();
      if (error || !data) throw new Error(`Error creando profesional_sede: ${error?.message}`);
      psId = data.id;
    }

    // Horarios L-V con pausa 12-1pm
    for (let dia = 1; dia <= 5; dia++) {
      const { data: hExist } = await db
        .from("horarios_atencion")
        .select("id")
        .eq("profesional_sede_id", psId)
        .eq("dia_semana", dia)
        .maybeSingle();
      if (hExist) continue;

      await db.from("horarios_atencion").insert({
        tenant_id: tenantId,
        profesional_sede_id: psId,
        dia_semana: dia,
        hora_inicio: "08:00:00",
        hora_fin: "17:00:00",
        tiene_pausa: true,
        pausa_inicio: "12:00:00",
        pausa_fin: "13:00:00",
        activo: true,
      });
    }

    // Servicios
    for (const srv of SERVICIOS_CONFIG) {
      const { data: sExist } = await db
        .from("servicios")
        .select("id")
        .eq("profesional_sede_id", psId)
        .eq("codigo", srv.codigo)
        .maybeSingle();
      if (sExist) continue;

      await db.from("servicios").insert({
        tenant_id: tenantId,
        profesional_sede_id: psId,
        codigo: srv.codigo,
        nombre: srv.nombre,
        duracion_min: srv.duracion,
        precio: srv.precio,
        moneda: "DOP",
        activo: true,
      });
    }
  }

  console.log(`\n   ✓ Sedes, horarios y servicios completos`);

  // 6. Aceptar todas las aseguradoras (precios base, sin override)
  const { data: aseguradoras } = await db
    .from("aseguradoras")
    .select("id")
    .is("tenant_id", null);

  const { data: serviciosCreados } = await db
    .from("servicios")
    .select("id")
    .eq("tenant_id", tenantId);

  if (aseguradoras && serviciosCreados) {
    for (const srv of serviciosCreados) {
      for (const ars of aseguradoras) {
        await db
          .from("servicio_aseguradora")
          .upsert({
            servicio_id: srv.id,
            aseguradora_id: ars.id,
            acepta: true,
          });
      }
    }
    console.log(`   ✓ Aseguradoras vinculadas: ${aseguradoras.length} ARS aceptadas`);
  }

  // 7. Canal Telegram
  const { data: canalExist } = await db
    .from("canales_conectados")
    .select("id")
    .eq("tipo", "telegram")
    .eq("identificador", BOT_USERNAME)
    .maybeSingle();

  if (canalExist) {
    console.log(`   ℹ️  Canal Telegram ya existe`);
  } else {
    // Las credenciales reales (token) viven en env, aquí solo guardamos referencia.
    // En producción se cifrarían con CREDENTIALS_ENCRYPTION_KEY.
    await db.from("canales_conectados").insert({
      tenant_id: tenantId,
      tipo: "telegram",
      identificador: BOT_USERNAME,
      nombre_display: "María Lab (testing)",
      credenciales_cifradas: "stored_in_env_TELEGRAM_BOT_TOKEN",
      estado: "activo",
    });
    console.log(`   ✓ Canal Telegram conectado: @${BOT_USERNAME}`);
  }

  console.log(`\n🎉 Seed completo.\n`);
  console.log(`   tenant_id: ${tenantId}`);
  console.log(`   profesional: Dr. Hairol Pérez`);
  console.log(`   sedes: ${SEDES_CONFIG.length}`);
  console.log(`   servicios: ${SERVICIOS_CONFIG.length} por sede`);
  console.log(`   bot Telegram: @${BOT_USERNAME}\n`);
  console.log(`Próximo paso: npm run test:agendar`);
}

main().catch(err => {
  console.error("\n❌ Error en seed:", err);
  process.exit(1);
});
