import "server-only";
import { db } from "../db";
import * as addressService from "./address/address";
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
