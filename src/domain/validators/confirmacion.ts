// src/domain/validators/confirmacion.ts
// Validación estructural del contexto de sesión antes de confirmar una cita.
// Pertenece al dominio: valida que los datos de negocio estén completos.
// Sin imports de infraestructura ni de application.

export interface ContextoConfirmacion {
  profesional_sede_id: string;
  servicio_id: string;
  servicio_nombre: string;
  servicio_precio: number;
  inicia_en: string;
  paciente_nombre: string;
  paciente_apellido: string;
  paciente_telefono: string;
  tipo_pago: string;
}

const CAMPOS_REQUERIDOS: (keyof ContextoConfirmacion)[] = [
  "profesional_sede_id",
  "servicio_id",
  "servicio_nombre",
  "servicio_precio",
  "inicia_en",
  "paciente_nombre",
  "paciente_telefono",
  "tipo_pago",
];

export function validarContextoConfirmacion(
  ctx: Record<string, unknown>,
): ContextoConfirmacion | null {
  for (const campo of CAMPOS_REQUERIDOS) {
    if (ctx[campo] === undefined || ctx[campo] === null) return null;
  }
  return {
    profesional_sede_id: String(ctx["profesional_sede_id"]),
    servicio_id:         String(ctx["servicio_id"]),
    servicio_nombre:     String(ctx["servicio_nombre"]),
    servicio_precio:     Number(ctx["servicio_precio"]),
    inicia_en:           String(ctx["inicia_en"]),
    paciente_nombre:     String(ctx["paciente_nombre"]),
    paciente_apellido:   String(ctx["paciente_apellido"] ?? ""),
    paciente_telefono:   String(ctx["paciente_telefono"]),
    tipo_pago:           String(ctx["tipo_pago"]),
  };
}
