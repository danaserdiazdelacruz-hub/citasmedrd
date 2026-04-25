// src/domain/validators/index.ts
// Barrel export para que los casos de uso importen limpio:
//   import { validatePhoneDO, validateName } from "@/domain/validators";

export { validatePhoneDO, formatPhoneDO } from "./phone.js";
export type { PhoneValidationResult } from "./phone.js";

export { validateName } from "./name.js";
export type { NameValidationResult } from "./name.js";

export { validateCedulaDO } from "./document-id.js";
export type { CedulaValidationResult } from "./document-id.js";

export { validateEmail } from "./email.js";
export type { EmailValidationResult } from "./email.js";
