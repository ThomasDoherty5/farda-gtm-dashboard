import { BUNDLES, costKeys, type OfferTerms, type ProviderFacts } from "./contract.ts";

const rateAmount = (minor: number, bps: number) => Math.round(minor * bps / 10_000);

/** Net merchandise excludes shipping, tax and subscriptions. Sample units belong to the seeded cohort once. */
export type OfferPrices = ReadonlyArray<{ id: string; units: number; merchandiseMinor: number; shippingMinor: number }>;
export function offerScenario(terms: OfferTerms, label: "base" | "downside", prices: OfferPrices = BUNDLES) {
  const line = terms[label], bundle = prices.find(b=>b.id===line.bundle);
  if(!bundle || line.refundPerOrderMinor+line.sellerDiscountMinor+line.platformCouponMinor>bundle.merchandiseMinor)throw new Error("INVALID_PRICE_ALLOCATION");
  const missing: string[] = [];
  const cost = (key: typeof costKeys[number]) => {
    const value = terms.costs[key].minor;
    if (value === null) missing.push(key);
    return value;
  };
  const landed = cost("landedUnit"), fulfillment = cost("fulfillmentPerOrder"), fee = cost("providerFeePerOrder"), defects = cost("returnDefectPerOrder");
  const advertising = cost("advertising"), recruitment = cost("recruitment"), earned = cost("earnedRewards");
  const samplePostage = terms.sample.requested ? cost("samplePostagePerCreator") : 0;
  const sample = !terms.sample.requested || terms.sample.seededCreators === 0 ? 0 : landed === null || samplePostage === null ? null :
    terms.sample.seededCreators * (terms.sample.unitsPerCreator * landed + samplePostage);
  const couponFundingUnknown = line.platformCouponMinor > 0 && line.fundedCouponMinor === null;
  if (couponFundingUnknown) missing.push("platformCouponFunding");
  // An unverified subsidy never improves the downside preview.
  const net = bundle.merchandiseMinor - line.sellerDiscountMinor - line.refundPerOrderMinor - line.platformCouponMinor + (line.fundedCouponMinor ?? 0);
  const merchandise = net * line.orders;
  const commissionPerOrder = terms.commission.type === "percentage" ? rateAmount(net,terms.commission.standardRateBps!) :
    (net === 0 ? 0 : terms.commission.fixedMinor!);
  if(line.shopAdsOrders && terms.commission.shopAdsRateBps === null) missing.push("shopAdsRate");
  const commission = line.shopAdsOrders && terms.commission.shopAdsRateBps === null ? null :
    commissionPerOrder*(line.orders-line.shopAdsOrders) + line.shopAdsOrders*rateAmount(net,terms.commission.shopAdsRateBps ?? 0);
  const perOrder = landed === null || fulfillment === null || fee === null || defects === null || couponFundingUnknown || commission === null ? null :
    net + bundle.shippingMinor - (landed*bundle.units+fulfillment+fee+defects) -
    (line.orders ? commission / line.orders : commissionPerOrder);
  const reserve = rateAmount(merchandise,500);
  const fixedCosts = sample === null || advertising === null || recruitment === null ? null : sample + advertising + recruitment;
  // The planning reserve is consumed by earned liabilities; redemptions and paid commission are cash settlement of existing accruals.
  const contribution = perOrder === null || fixedCosts === null || earned === null ? null :
    Math.round(perOrder*line.orders) - fixedCosts - Math.max(earned,reserve);
  const reservePerOrder = net * 0.05;
  const breakEven = perOrder !== null && fixedCosts !== null && earned !== null && perOrder > reservePerOrder ?
    Math.ceil(Math.max((fixedCosts+earned)/perOrder, fixedCosts/(perOrder-reservePerOrder))) : null;
  return { label, orders:line.orders, seededCreators:terms.sample.seededCreators,
    zeroSaleSeededCreatorsMinimum:Math.max(0,terms.sample.seededCreators-line.orders), merchandiseMinor:merchandise, shippingRevenueMinor:bundle.shippingMinor*line.orders,
    commissionMinor:couponFundingUnknown ? null : commission, fixedCostsMinor:fixedCosts, sampleMinor:sample, contributionMinor:contribution,
    perOrderMarginMinor:perOrder===null?null:Math.round(perOrder), breakEvenOrders:breakEven, reserveMinor:reserve, earnedRewardMinor:earned,
    paidCommissionCashMinor:terms.costs.commissionAlreadyPaid.minor, missing: [...new Set(missing)] };
}
export function proposalBlockers(terms: OfferTerms, provider: ProviderFacts | null, verifiedCostKeys: Set<string>, now: string, verifiedFunding = new Set<string>(), prices: OfferPrices = BUNDLES) {
  const blockers: string[] = [];
  if (!provider) blockers.push("Provider terms and program entitlement unverified");
  else {
    if(terms.commission.type==="fixed-per-sale" && !provider.supportsFixedPerSale || terms.commission.type==="percentage" && !provider.supportsPercentage)
      blockers.push("Provider does not support this commission structure");
    if (Date.parse(provider.validUntil) <= Date.parse(now)) blockers.push("Provider evidence expired");
    if (provider.actualCommission.type!==terms.commission.type || provider.actualCommission.standardRateBps!==terms.commission.standardRateBps ||
      provider.actualCommission.shopAdsRateBps!==terms.commission.shopAdsRateBps || provider.actualCommission.fixedMinor!==terms.commission.fixedMinor ||
      provider.actualCommission.effectiveAt!==terms.commission.effectiveAt) blockers.push("Proposed commission differs from the sourced provider terms");
    if (provider.attributionWindowDays===null || !provider.precedence || !provider.conflictRule || provider.holdDays===null || !provider.payoutSchedule ||
      provider.payoutThresholdMinor===null || !provider.onboarding || !provider.feeTreatment || !provider.refundRule || !provider.fundingRule)
      blockers.push("Provider attribution, payout or refund rules incomplete");
  }
  if (terms.commission.type==="fixed-per-sale" && terms.provider!=="external-affiliate") blockers.push("Fixed-per-sale requires a verified compatible external provider");
  if (terms.recruitmentSource.toLowerCase().replace(/[ -]/g,"")==="socialcat" &&
      (!terms.sample.requested || !terms.sample.seededCreators || !terms.sample.unitsPerCreator || terms.sample.merchandiseCapMinor===null || terms.sample.shippingCapMinor===null))
    blockers.push("Social Cat Affiliate needs product and shipping allocation bounds");
  if(terms.sample.requested && (!terms.sample.unitsPerCreator || !terms.sample.seededCreators || terms.sample.merchandiseCapMinor===null || terms.sample.shippingCapMinor===null ||
    terms.costs.landedUnit.minor!==null && terms.sample.merchandiseCapMinor<terms.costs.landedUnit.minor*terms.sample.unitsPerCreator ||
    terms.costs.samplePostagePerCreator.minor!==null && terms.sample.shippingCapMinor<terms.costs.samplePostagePerCreator.minor))
    blockers.push("Sample or shipping cap missing or exceeded");
  if (!terms.manifest.productRef || !terms.manifest.productRevision || !terms.manifest.claimsRefs.length || !terms.manifest.guidanceRefs.length ||
    !terms.manifest.contactRoute || terms.manifest.campaignRef==="unassigned") blockers.push("Production brief has unresolved product, guidance, campaign or contact information");
  if (terms.manifest.claims.includes("separate-routines") && terms.manifest.productUse!=="separate-products-one-per-vial") blockers.push("Multipack use must specify one medication product per vial");
  if(!terms.expiresAt || Date.parse(terms.expiresAt)<=Date.parse(now)) blockers.push("Proposal expiry missing or expired");
  for (const key of costKeys.filter(k=>k!=="commissionAlreadyPaid" && (k!=="samplePostagePerCreator" || terms.sample.requested)))
    if(!verifiedCostKeys.has(key)) blockers.push(`Cost evidence unverified: ${key}`);
  for (const label of ["base","downside"] as const) {
    const scenario=offerScenario(terms,label,prices);
    if(terms[label].platformCouponMinor>0 && !verifiedFunding.has(label)) blockers.push(`Platform subsidy unverified: ${label}`);
    if(scenario.contributionMinor===null || scenario.contributionMinor<=0 || !scenario.orders) blockers.push(`Cohort payback unproven: ${label}`);
  }
  return blockers;
}
