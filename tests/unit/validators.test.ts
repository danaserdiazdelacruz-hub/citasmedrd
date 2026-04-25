// tests/unit/validators.test.ts
// Tests de los validators puros. Sin DB, sin mocks.
// Corren con: npm test

import { describe, it, expect } from "vitest";
import {
  validatePhoneDO,
  formatPhoneDO,
  validateName,
  validateCedulaDO,
  validateEmail,
} from "../../src/domain/validators/index.js";

describe("validatePhoneDO", () => {
  it("acepta formatos comunes", () => {
    const cases = [
      "8094563214",
      "+18094563214",
      "1-809-456-3214",
      "(809) 456 3214",
      "809.456.3214",
      "1 809 456 3214",
    ];
    for (const raw of cases) {
      const r = validatePhoneDO(raw);
      expect(r.valid, `falla para "${raw}"`).toBe(true);
      expect(r.normalized).toBe("+18094563214");
    }
  });

  it("rechaza prefijos no dominicanos", () => {
    expect(validatePhoneDO("7194563214").valid).toBe(false);
    expect(validatePhoneDO("5554563214").valid).toBe(false);
  });

  it("rechaza longitudes incorrectas", () => {
    expect(validatePhoneDO("80945632").valid).toBe(false);          // muy corto
    expect(validatePhoneDO("80945632149").valid).toBe(false);       // 11 sin 1 inicial
    expect(validatePhoneDO("").valid).toBe(false);
  });

  it("acepta 829 y 849", () => {
    expect(validatePhoneDO("8294563214").normalized).toBe("+18294563214");
    expect(validatePhoneDO("8494563214").normalized).toBe("+18494563214");
  });

  it("rechaza no-strings", () => {
    expect(validatePhoneDO(null).valid).toBe(false);
    expect(validatePhoneDO(undefined).valid).toBe(false);
    expect(validatePhoneDO(8094563214).valid).toBe(false);
  });

  it("formatPhoneDO formatea correctamente", () => {
    expect(formatPhoneDO("+18094563214")).toBe("809-456-3214");
  });
});

describe("validateName", () => {
  it("acepta nombres reales", () => {
    const r = validateName("Juan Pérez");
    expect(r.valid).toBe(true);
    expect(r.nombre).toBe("Juan");
    expect(r.apellido).toBe("Pérez");
  });

  it("normaliza capitalización", () => {
    const r = validateName("juan PEREZ");
    expect(r.nombre).toBe("Juan");
    expect(r.apellido).toBe("Perez");
  });

  it("acepta nombres compuestos", () => {
    const r = validateName("María Del Carmen García");
    expect(r.valid).toBe(true);
    expect(r.nombre).toBe("María");
    expect(r.apellido).toBe("Del Carmen García");
  });

  it("descarta apellidos prohibidos", () => {
    const r = validateName("Juan Paciente");
    expect(r.valid).toBe(true);
    expect(r.apellido).toBe("");
  });

  it("rechaza nombres con basura", () => {
    const r = validateName("Rita bbb");
    expect(r.valid).toBe(true);
    expect(r.apellido).toBe("");
    expect(r.suspicious).toBe(true);
  });

  it("rechaza caracteres inválidos", () => {
    expect(validateName("<script>").valid).toBe(false);
    expect(validateName("Juan@Pérez").valid).toBe(false);
    expect(validateName("123 456").valid).toBe(false);
  });

  it("rechaza strings vacíos o muy cortos", () => {
    expect(validateName("").valid).toBe(false);
    expect(validateName("a").valid).toBe(false);
    expect(validateName(null).valid).toBe(false);
  });
});

describe("validateCedulaDO", () => {
  it("acepta cédulas con Luhn válido", () => {
    // Cédula de prueba que pasa Luhn (verificador calculado)
    // Generamos una válida: 00112345678 donde 8 es el verificador correcto
    // Usamos una conocida por aritmética; si la tuya real, sustituye.
    // Cédula ejemplo 001-1234567-8:
    //   dígitos: 0,0,1,1,2,3,4,5,6,7 * [1,2,1,2,1,2,1,2,1,2]
    //   = 0,0,1,2,2,6,4,10→1,6,14→5 → suma = 27
    //   (10 - 27%10) %10 = (10-7)%10 = 3
    //   verificador esperado = 3
    const r = validateCedulaDO("00112345673");
    expect(r.valid).toBe(true);
    expect(r.normalized).toBe("001-1234567-3");
  });

  it("rechaza dígito verificador incorrecto", () => {
    const r = validateCedulaDO("00112345670");
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("verificador");
  });

  it("rechaza longitud incorrecta", () => {
    expect(validateCedulaDO("001123").valid).toBe(false);
    expect(validateCedulaDO("001123456789").valid).toBe(false);
  });

  it("acepta con separadores", () => {
    expect(validateCedulaDO("001-1234567-3").valid).toBe(true);
    expect(validateCedulaDO("001.1234567.3").valid).toBe(true);
  });
});

describe("validateEmail", () => {
  it("acepta emails válidos", () => {
    expect(validateEmail("test@example.com").valid).toBe(true);
    expect(validateEmail("user.name+tag@domain.co").valid).toBe(true);
    expect(validateEmail("  USER@DOMAIN.COM  ").normalized).toBe("user@domain.com");
  });

  it("rechaza formatos inválidos", () => {
    expect(validateEmail("nodomain").valid).toBe(false);
    expect(validateEmail("@nouser.com").valid).toBe(false);
    expect(validateEmail("user@").valid).toBe(false);
    expect(validateEmail("").valid).toBe(false);
  });
});
