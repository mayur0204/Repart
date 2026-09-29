import "server-only";
import { db } from "../db";
import { adapters } from "../adapters";
import { env } from "../env";
import * as addressService from "./address/address";
import * as catalogueAdmin from "./catalogue/admin";
import * as categoryService from "./catalogue/categories";
import * as importService from "./catalogue/import";
import * as interchangeService from "./interchange/interchange";
import * as signInService from "./auth/sign-in";
import * as catalogueService from "./catalogue/vehicles";
import * as consentService from "./consent/consent";
import * as garageService from "./garage/garage";
import * as profileService from "./profile/profile";

/**
 * Service entry points for app/** with the database client bound. Routes and actions import
 * these instead of `@/server/db` (enforced by lint); tests call the unbound functions with a test client.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fn = (db: any, ...args: any[]) => any;
type Bound<F> = F extends (db: never, ...args: infer A) => infer R ? (...args: A) => R : never;

function bind<T extends Record<string, Fn>>(fns: T): { [K in keyof T]: Bound<T[K]> } {
  return Object.fromEntries(Object.entries(fns).map(([k, f]) => [k, (...args: unknown[]) => f(db, ...args)])) as never;
}

export const signIn = bind({
  start: signInService.startPhoneSignIn,
  resend: signInService.resendCode,
  verify: signInService.verifyPhoneSignIn,
  pendingChallenge: signInService.getPendingChallenge,
});

export const consent = bind({
  list: consentService.listConsentStatus,
  grant: consentService.grantConsents,
  withdraw: consentService.withdrawConsent,
});

export const profile = bind({
  completeAboutYou: profileService.completeAboutYou,
  update: profileService.updateProfile,
  requestPersonalData: profileService.requestPersonalData,
});

export const addresses = bind({
  list: addressService.listAddresses,
  get: addressService.getAddress,
  create: addressService.createAddress,
  update: addressService.updateAddress,
  setDefault: addressService.setDefaultAddress,
  remove: addressService.deleteAddress,
});

export const garage = bind({
  list: garageService.listGarage,
  count: garageService.countGarage,
  get: garageService.getGarageVehicle,
  add: garageService.addGarageVehicle,
  update: garageService.updateGarageVehicle,
  setPrimary: garageService.setPrimaryVehicle,
  remove: garageService.removeGarageVehicle,
});

export const catalogue = bind({ vehicles: catalogueService.getVehicleCatalogue });

export const catalogueAdminService = bind({
  listMakes: catalogueAdmin.listMakes,
  saveMake: catalogueAdmin.saveMake,
  deleteMake: catalogueAdmin.deleteMake,
  listModels: catalogueAdmin.listModels,
  saveModel: catalogueAdmin.saveModel,
  deleteModel: catalogueAdmin.deleteModel,
  listVariants: catalogueAdmin.listVariants,
  saveVariant: catalogueAdmin.saveVariant,
  deleteVariant: catalogueAdmin.deleteVariant,
  listPartNumbers: catalogueAdmin.listPartNumbers,
  savePartNumber: catalogueAdmin.savePartNumber,
  deletePartNumber: catalogueAdmin.deletePartNumber,
});

export const categories = bind({
  list: categoryService.listCategories,
  get: categoryService.getCategory,
  save: categoryService.saveCategory,
  remove: categoryService.deleteCategory,
});

export const interchange = bind({
  partNumberPage: interchangeService.getPartNumberPage,
  suggest: interchangeService.suggestEquivalent,
  createLink: interchangeService.createLink,
  reviewQueue: interchangeService.reviewQueue,
  review: interchangeService.reviewLink,
});

const importDeps = (): importService.ImportDeps => ({ storage: adapters().storage, bucket: env().STORAGE_BUCKET_CATALOGUE_IMPORTS });

export const imports = {
  list: () => importService.listImports(db),
  get: (id: string) => importService.getImport(db, id),
  create: (...args: Parameters<typeof importService.createImport> extends [unknown, unknown, ...infer R] ? R : never) =>
    importService.createImport(db, importDeps(), ...args),
  apply: (...args: Parameters<typeof importService.applyImport> extends [unknown, unknown, ...infer R] ? R : never) =>
    importService.applyImport(db, importDeps(), ...args),
};
