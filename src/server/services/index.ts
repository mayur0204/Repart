import "server-only";
import { db } from "../db";
import { adapters } from "../adapters";
import { env } from "../env";
import * as addressService from "./address/address";
import * as catalogueAdmin from "./catalogue/admin";
import * as categoryService from "./catalogue/categories";
import * as importService from "./catalogue/import";
import * as interchangeService from "./interchange/interchange";
import * as listingService from "./listing/listing";
import * as photoService from "./listing/photos";
import * as messagingService from "./messaging/messaging";
import * as notificationService from "./notification/notification";
import * as riskPipeline from "./risk/pipeline";
import * as publicService from "./search/public";
import * as searchService from "./search/search";
import * as riskReview from "./risk/review";
import * as settingsService from "./settings/settings";
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

export const listings = bind({
  createDraft: listingService.createDraft,
  wizard: listingService.getWizardState,
  saveBike: listingService.saveBike,
  findPartNumbers: listingService.findCataloguePartNumbers,
  suggestedVariants: listingService.suggestedVariants,
  savePart: listingService.savePart,
  saveCondition: listingService.saveCondition,
  saveDetails: listingService.saveDetails,
  savePrice: listingService.savePrice,
  submit: listingService.submitListing,
  withdraw: listingService.withdrawListing,
  comparablePrice: listingService.comparablePriceRange,
  sellerListings: listingService.listSellerListings,
});

const photoDeps = (): photoService.PhotoDeps => ({ storage: adapters().storage, bucket: env().STORAGE_BUCKET_LISTING_PHOTOS });

export const photos = {
  requestUpload: (actor: { userId: string; requestId?: string }, input: Parameters<typeof photoService.requestPhotoUpload>[3]) =>
    photoService.requestPhotoUpload(db, photoDeps(), actor, input),
  confirmUpload: (actor: { userId: string; requestId?: string }, photoId: string) => photoService.confirmPhotoUpload(db, actor, photoId),
  remove: (actor: { userId: string; requestId?: string }, photoId: string) => photoService.deletePhoto(db, photoDeps(), actor, photoId),
  move: (actor: { userId: string; requestId?: string }, photoId: string, to: "up" | "down" | "first") => photoService.movePhoto(db, actor, photoId, to),
  listForOwner: (userId: string, listingId: string) => photoService.listPhotosForOwner(db, photoDeps(), userId, listingId),
  process: (photoId: string) => photoService.processListingPhoto(db, photoDeps(), photoId),
};

const riskDeps = (): riskPipeline.RiskDeps => ({ storage: adapters().storage, bucket: env().STORAGE_BUCKET_LISTING_PHOTOS, vision: adapters().vision });

export const risk = {
  run: (listingId: string) => riskPipeline.runRiskCheck(db, riskDeps(), listingId),
  reviewQueue: () => riskReview.listingReviewQueue(db),
  detail: (listingId: string) => riskReview.listingRiskDetail(db, photoDeps(), listingId),
  requestChanges: (actor: { userId: string; requestId?: string }, input: { listingId: string; reason: string }) => riskReview.adminRequestChanges(db, actor, input),
  reject: (actor: { userId: string; requestId?: string }, input: { listingId: string; reason: string }) => riskReview.adminReject(db, actor, input),
  clearReview: (actor: { userId: string; requestId?: string }, listingId: string, note?: string) => riskReview.clearListingReview(db, actor, listingId, note),
  statusForOwner: (userId: string, listingId: string) => riskReview.screeningStatusForOwner(db, userId, listingId),
};

export const settings = bind({
  active: settingsService.getActiveSettings,
  version: settingsService.getSettingsVersion,
  versions: settingsService.listSettingsVersions,
  create: settingsService.createSettingsVersion,
  activate: settingsService.activateSettingsVersion,
});

const publicDeps = () => ({ storage: adapters().storage, bucket: env().STORAGE_BUCKET_LISTING_PHOTOS });

/** Public marketplace reads (M6). Only public fields leave these functions. */
export const publicSearch = {
  search: (query: searchService.SearchQuery, vehicle: import("./search/fit").Vehicle | null) => searchService.searchListings(db, query, { vehicle, deps: publicDeps() }),
  resolveVehicle: (variantId: string, year?: number | null) => searchService.resolveVehicle(db, variantId, year),
  listing: (id: string, ctx: { vehicle: import("./search/fit").Vehicle | null; pincode: string | null }) =>
    publicService.getPublicListing(db, { ...publicDeps(), shipping: adapters().shipping }, id, ctx),
  seller: (sellerId: string) => publicService.getSellerProfile(db, publicDeps(), sellerId),
  toggleSaved: (userId: string, listingId: string) => publicService.toggleSavedListing(db, userId, listingId),
  isSaved: (userId: string, listingId: string) => publicService.isSaved(db, userId, listingId),
  saved: (userId: string, vehicle: import("./search/fit").Vehicle | null) => publicService.listSavedListings(db, publicDeps(), userId, vehicle),
  report: (userId: string, input: unknown) => publicService.reportListing(db, userId, input),
  saveSearch: (userId: string, input: { query: searchService.SearchQuery; label: string }) => publicService.saveSearch(db, userId, input),
  savedSearches: (userId: string) => publicService.listSavedSearches(db, userId),
  setAlerts: (userId: string, id: string, enabled: boolean) => publicService.setSavedSearchAlerts(db, userId, id, enabled),
  deleteSearch: (userId: string, id: string) => publicService.deleteSavedSearch(db, userId, id),
  alertSavedSearches: (listingId: string) => publicService.alertSavedSearches(db, listingId),
};

/** Messages (M7). Every call checks the caller takes part in the conversation. */
export const messaging = {
  start: (userId: string, listingId: string) => messagingService.startConversation(db, userId, listingId),
  inbox: (userId: string) => messagingService.listInbox(db, publicDeps(), userId),
  thread: (userId: string, conversationId: string) => messagingService.getThread(db, publicDeps(), userId, conversationId),
  messages: (userId: string, conversationId: string, after?: string) => messagingService.getMessages(db, userId, conversationId, after),
  send: (actor: { userId: string; requestId?: string }, input: unknown) => messagingService.sendMessage(db, actor, input),
  markRead: (userId: string, conversationId: string) => messagingService.markRead(db, userId, conversationId),
  report: (userId: string, input: unknown) => messagingService.reportMessage(db, userId, input),
  deliverNotification: (payload: Parameters<typeof notificationService.deliverNotification>[2]) => notificationService.deliverNotification(db, adapters().notification, payload),
};
