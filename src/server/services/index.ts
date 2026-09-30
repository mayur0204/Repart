import "server-only";
import { db } from "../db";
import { adapters, shippingWebhookSecret } from "../adapters";
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
import * as orderCheckout from "./order/checkout";
import * as orderFulfilment from "./order/fulfilment";
import * as disputeService from "./order/disputes";
import * as inspectionService from "./inspection/inspection";
import * as tracking from "./shipping/tracking";
import * as orderLifecycle from "./order/lifecycle";
import * as orderRead from "./order/read";
import * as paymentEvents from "./payment/payment-events";
import * as reconciliationService from "./payment/reconciliation";
import * as refundService from "./payment/refunds";
import * as settlementService from "./payment/settlement";
import * as vendorOnboarding from "./payment/vendor-onboarding";
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

/** Seller payout onboarding as a Cashfree Easy Split vendor (M8). Provider chosen by PAYMENT_PROVIDER. */
export const payouts = {
  summary: (userId: string) => vendorOnboarding.getPayoutSummary(db, userId),
  submit: (actor: { userId: string; requestId?: string }, input: unknown) => vendorOnboarding.submitPayoutOnboarding(db, adapters().payment, actor, input),
  sync: (userId: string) => vendorOnboarding.syncPayoutStatus(db, adapters().payment, userId),
};

/** Checkout, orders and payments (M8). Amounts are always computed server-side; the provider is chosen by PAYMENT_PROVIDER. */
export const orders = {
  price: (buyerId: string, input: { listingId: string; addressId?: string; withCheck: boolean }) => orderCheckout.priceListing(db, adapters(), buyerId, input),
  place: (actor: { userId: string; requestId?: string }, input: unknown) => orderCheckout.placeOrder(db, adapters(), actor, input),
  pay: (actor: { userId: string; requestId?: string }, orderId: string) => orderCheckout.payOrder(db, adapters(), actor, orderId, env().APP_BASE_URL),
  confirm: (orderId: string) => paymentEvents.confirmFromProvider(db, adapters().payment, orderId),
  forUser: (userId: string, orderId: string) => orderRead.orderForUser(db, userId, orderId),
  list: (userId: string) => orderRead.ordersForUser(db, userId),
  adminList: () => orderRead.adminOrders(db),
  adminGet: (orderId: string) => orderRead.adminOrder(db, orderId),
  adminCancel: (admin: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderLifecycle.adminCancelOrder(db, admin, orderId, input),
  adminRefund: (admin: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderLifecycle.adminRefundOnly(db, admin, orderId, input),
  resolveDispute: (admin: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderLifecycle.resolveDispute(db, admin, orderId, input),
  reconciliation: () => orderRead.reconciliationOverview(db),
  resolveMismatch: (adminId: string, mismatchId: string) => orderRead.resolveMismatch(db, adminId, mismatchId),
  /** Provider webhook. `expected` guards the route: a mock webhook is never accepted while Cashfree is live, and vice versa. */
  webhook: (expected: "mock" | "cashfree", rawBody: string, headers: Headers) => {
    const payment = adapters().payment;
    if (payment.name !== expected) return Promise.resolve({ status: 404, outcome: "rejected" as const });
    return paymentEvents.receivePaymentWebhook(db, payment, rawBody, headers);
  },
  mockPay: (buyerId: string, orderId: string, outcome: "SUCCESS" | "FAILED" | "USER_DROPPED") => paymentEvents.simulateMockPayment(db, adapters().payment, buyerId, orderId, outcome),
  // Worker jobs
  expirePayment: (orderId: string) => orderLifecycle.expirePayment(db, adapters().payment, orderId),
  sellerTimeout: (orderId: string) => orderLifecycle.sellerTimeout(db, orderId),
  releaseSettlement: (orderId: string) => settlementService.releaseSettlement(db, adapters().payment, orderId),
  processRefund: (refundId: string) => refundService.processRefund(db, adapters().payment, refundId),
  sweep: () => orderLifecycle.sweepOrders(db, adapters().payment),
  reconcile: () => reconciliationService.runReconciliation(db, adapters().payment),
};

/** Seller order handling and shipping (M9). The courier is chosen by SHIPPING_PROVIDER; refunds reuse the M8 refund service. */
export const fulfilment = {
  sellerOrders: (sellerId: string) => orderRead.sellerOrders(db, sellerId),
  sellerOrder: (sellerId: string, orderId: string) => orderRead.sellerOrder(db, sellerId, orderId),
  confirm: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderFulfilment.confirmOrder(db, adapters(), actor, orderId, input),
  decline: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderFulfilment.declineOrder(db, actor, orderId, input),
  schedulePickup: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderFulfilment.schedulePickup(db, adapters(), actor, orderId, input),
  afterInspectionPassed: (orderId: string) => orderFulfilment.afterInspectionPassed(db, adapters(), orderId),
  buyerCancel: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderFulfilment.buyerCancelOrder(db, adapters(), actor, orderId, input),
  confirmHandover: (actor: { userId: string; requestId?: string }, orderId: string) => orderFulfilment.confirmHandover(db, actor, orderId),
  adminConfirmReturn: (admin: { userId: string; requestId?: string }, orderId: string, input: unknown) => orderFulfilment.adminConfirmReturn(db, admin, orderId, input),
  /** Courier webhook. `provider` must be the configured courier, so another provider's route can't be used. */
  trackingWebhook: (provider: string, rawBody: string, headers: Headers) => {
    const shipping = adapters().shipping;
    if (shipping.name !== provider) return Promise.resolve({ status: 404, outcome: "rejected" as const });
    return tracking.receiveTrackingWebhook(db, shipping, rawBody, headers);
  },
  devAdvance: (orderId: string, status: (typeof tracking.DEV_TRACKING_STATUSES)[number]) =>
    tracking.devAdvanceShipment(db, adapters().shipping, shippingWebhookSecret(), orderId, status),
};

/** Partner Checks, the mechanic portal and garage admin (M10). Photos live in the private inspection bucket. */
const inspectionDeps = (): inspectionService.InspectionDeps => ({ storage: adapters().storage, bucket: env().STORAGE_BUCKET_INSPECTION_PHOTOS, listingBucket: env().STORAGE_BUCKET_LISTING_PHOTOS, shipping: adapters().shipping });
export const inspections = {
  jobs: (userId: string) => inspectionService.mechanicJobs(db, userId),
  job: (userId: string, inspectionId: string) => inspectionService.mechanicJob(db, inspectionDeps(), userId, inspectionId),
  history: (userId: string) => inspectionService.mechanicHistory(db, userId),
  requestPhoto: (actor: { userId: string; requestId?: string }, input: { inspectionId: string; shotType: string; size: number; type: string }) => inspectionService.requestInspectionPhoto(db, inspectionDeps(), actor, input),
  confirmPhoto: (actor: { userId: string; requestId?: string }, photoId: string) => inspectionService.confirmInspectionPhoto(db, inspectionDeps(), actor, photoId),
  submit: (actor: { userId: string; requestId?: string }, inspectionId: string, input: Record<string, unknown>) => inspectionService.submitInspection(db, inspectionDeps(), actor, inspectionId, input),
  partnerCheckFor: (listingId: string) => inspectionService.partnerCheckFor(db, listingId),
  coverageForListing: async (listingId: string) => {
    const l = await db.listing.findUnique({ where: { id: listingId }, select: { pickupPincode: true } });
    return inspectionService.hasCoverage(db, l?.pickupPincode);
  },
  expireLabels: () => inspectionService.expirePartnerCheckLabels(db),
  // Admin
  garages: () => inspectionService.adminGarages(db),
  garage: (id: string) => inspectionService.adminGarage(db, id),
  saveGarage: (admin: { userId: string; requestId?: string }, input: unknown) => inspectionService.saveGarage(db, admin, input),
  linkMechanic: (admin: { userId: string; requestId?: string }, input: unknown) => inspectionService.linkMechanic(db, admin, input),
  setStaffActive: (admin: { userId: string; requestId?: string }, staffId: string, active: boolean) => inspectionService.setStaffActive(db, admin, staffId, active),
  reassign: (admin: { userId: string; requestId?: string }, input: unknown) => inspectionService.reassignInspection(db, admin, input),
  reassignmentOptions: (orderId: string) => inspectionService.reassignmentOptions(db, orderId),
};

/** Acceptance, disputes, reviews and the hold-deadline watch (M11). Evidence lives in the private dispute-evidence bucket. */
const disputeDeps = (): disputeService.DisputeDeps => ({ storage: adapters().storage, bucket: env().STORAGE_BUCKET_DISPUTE_EVIDENCE, shipping: adapters().shipping });
export const disputes = {
  accept: (actor: { userId: string; requestId?: string }, orderId: string) => disputeService.acceptOrder(db, actor, orderId),
  report: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => disputeService.reportProblem(db, actor, orderId, input),
  respond: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => disputeService.sellerRespond(db, actor, orderId, input),
  requestEvidence: (actor: { userId: string; requestId?: string }, input: { disputeId: string; size: number; type: string }) => disputeService.requestEvidenceUpload(db, disputeDeps(), actor, input),
  confirmEvidence: (actor: { userId: string; requestId?: string }, evidenceId: string) => disputeService.confirmEvidenceUpload(db, disputeDeps(), actor, evidenceId),
  forUser: (userId: string, orderId: string) => disputeService.disputeForUser(db, disputeDeps(), userId, orderId),
  adminList: () => disputeService.adminDisputes(db),
  adminGet: (disputeId: string) => disputeService.adminDispute(db, disputeDeps(), disputeId),
  bookReturn: (orderId: string) => disputeService.bookDisputeReturn(db, disputeDeps(), orderId),
  reviewState: (userId: string, orderId: string) => disputeService.reviewState(db, userId, orderId),
  review: (actor: { userId: string; requestId?: string }, orderId: string, input: unknown) => disputeService.submitReview(db, actor, orderId, input),
  nearAutoRelease: () => disputeService.nearAutoRelease(db),
  // Worker jobs
  acceptanceTimeout: (orderId: string) => disputeService.acceptanceTimeout(db, orderId),
  holdDeadlineWatch: () => disputeService.holdDeadlineWatch(db),
};
