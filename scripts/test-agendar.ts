// scripts/test-agendar.ts
// Prueba end-to-end del bloque 5: agenda una cita real en tu Supabase
// SIN usar bot, sin LLM, sin canal — solo línea de comandos.
//
// Si esto crea una fila en `citas`, los bloques 1-5 funcionan correctamente.
//
// Ejecutar:
//   npm run test:agendar

import { getDb } from "../src/persistence/db.js";
import { agendarCita, listarHorariosLibres } from "../src/application/use-cases/index.js";

const TENANT_SLUG = "red-unidades-oncologicas";

async function main(): Promise<void> {
  const db = getDb();

  console.log("🧪 Prueba end-to-end de agendar cita\n");

  // 1. Encontrar tenant
  const { data: tenant } = await db
    .from("tenants")
    .select("id, nombre_comercial")
    .eq("slug", TENANT_SLUG)
    .single();
  if (!tenant) {
    throw new Error(`Tenant ${TENANT_SLUG} no encontrado. Corre primero: npm run seed:tenant`);
  }
  console.log(`   ✓ Tenant: ${tenant.nombre_comercial} (${tenant.id})`);

  // 2. Encontrar primera sede del tenant
  const { data: ps } = await db
    .from("profesional_sede")
    .select(`
      id,
      sedes!inner ( nombre )
    `)
    .eq("tenant_id", tenant.id)
    .eq("activo", true)
    .limit(1)
    .single();
  if (!ps) throw new Error("No hay profesional_sede para este tenant");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sedeNombre = (ps as any).sedes.nombre;
  console.log(`   ✓ Sede: ${sedeNombre}`);

  // 3. Encontrar primer servicio de esa sede
  const { data: servicio } = await db
    .from("servicios")
    .select("id, nombre, precio, duracion_min")
    .eq("profesional_sede_id", ps.id)
    .eq("activo", true)
    .limit(1)
    .single();
  if (!servicio) throw new Error("No hay servicios para esta sede");
  console.log(`   ✓ Servicio: ${servicio.nombre} (RD$${servicio.precio}, ${servicio.duracion_min} min)`);

  // 4. Buscar próximo horario libre (mañana)
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Si mañana es sábado o domingo, saltar al lunes
  const dow = tomorrow.getDay();
  if (dow === 0) tomorrow.setDate(tomorrow.getDate() + 1);   // dom → lun
  if (dow === 6) tomorrow.setDate(tomorrow.getDate() + 2);   // sáb → lun
  const fecha = tomorrow.toISOString().slice(0, 10);
  console.log(`   → Buscando horarios libres para: ${fecha}`);

  const slots = await listarHorariosLibres({
    profesionalSedeId: ps.id,
    fecha,
  });

  if (slots.length === 0) {
    throw new Error(`No hay horarios libres para ${fecha} en ${sedeNombre}`);
  }
  console.log(`   ✓ ${slots.length} slots libres. Primero: ${slots[0].horaDisplay}`);

  // 5. Agendar en el primer slot libre
  const slot = slots[0];
  console.log(`\n   → Agendando paciente de prueba en ${slot.horaDisplay}…`);

  const result = await agendarCita({
    tenantId: tenant.id,
    profesionalSedeId: ps.id,
    servicioId: servicio.id,
    iniciaEn: slot.iniciaEn,
    canalOrigen: "api",
    pacienteTelefono: "8094563214",
    pacienteNombre: "María",
    pacienteApellido: "Pérez",
    motivoVisita: "prueba end-to-end del backend",
    tipoPago: "efectivo",
  });

  console.log(`\n🎉 Cita creada exitosamente:\n`);
  console.log(`   código:       ${result.codigo}`);
  console.log(`   cita_id:      ${result.citaId}`);
  console.log(`   paciente_id:  ${result.pacienteId}`);
  console.log(`   paciente_creado: ${result.pacienteCreado}`);
  console.log(`\nVerifícalo en Supabase:`);
  console.log(`   SELECT * FROM citas WHERE codigo = '${result.codigo}';\n`);
}

main().catch(err => {
  console.error("\n❌ Error en test-agendar:");
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    console.error(`   error_code: ${err.code}`);
    console.error(`   message: ${err.message}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
