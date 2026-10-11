/**
 * Logistics and Marketplace Integration Brand Registry
 * Official logos, vector marks, and brand assets retrieved via Brandfetch MCP.
 * Implements TypeUI design system tokens and WCAG 2.2 AA compliant badges.
 */

export interface CarrierBrand {
  id: string;
  name: string;
  code: string;
  domain: string;
  logoUrl: string;
  iconUrl: string;
  brandColor: string;
  accentColor: string;
  textColor: string;
  trackingPrefixes: string[];
  trackingPattern: RegExp;
  trackingUrl: (awb: string) => string;
  description: string;
  status: 'active' | 'integrated' | 'supported';
}

export interface MarketplaceBrand {
  id: string;
  name: string;
  code: string;
  domain: string;
  logoUrl: string;
  iconUrl: string;
  brandColor: string;
  accentColor: string;
  textColor: string;
  description: string;
}

export interface PaymentGatewayBrand {
  id: string;
  name: string;
  code: string;
  domain: string;
  logoUrl: string;
  iconUrl: string;
  brandColor: string;
  accentColor: string;
  textColor: string;
  description: string;
  paymentModes: string[];
  settlementCycle: string;
  portalUrl?: string;
}

// Brandfetch verified logistics partners
export const CARRIER_REGISTRY: Record<string, CarrierBrand> = {
  delhivery: {
    id: 'idz2dv9TsL',
    name: 'Delhivery',
    code: 'DELHIVERY',
    domain: 'delhivery.com',
    logoUrl: 'https://cdn.brandfetch.io/idz2dv9TsL/theme/dark/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idz2dv9TsL/w/128/h/128/fallback/lettermark/icon.webp?c=1ax1791805419035idZyD0yYjDLiPfF2SM',
    brandColor: '#101218',
    accentColor: '#ea4333',
    textColor: '#ffffff',
    trackingPrefixes: ['149', '12', '13', '33'],
    trackingPattern: /^(149\d{10,14}|12\d{10,12}|13\d{10,12}|33\d{10,12}|\d{12,16})$/,
    trackingUrl: (awb) => `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`,
    description: "India's largest integrated logistics provider — express parcel, freight, and supply chain.",
    status: 'active',
  },
  shadowfax: {
    id: 'id0OmBVeZh',
    name: 'Shadowfax',
    code: 'SHADOWFAX',
    domain: 'shadowfax.in',
    logoUrl: 'https://cdn.brandfetch.io/id0OmBVeZh/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/id0OmBVeZh/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#000000',
    accentColor: '#f2ee1b',
    textColor: '#ffffff',
    trackingPrefixes: ['SF'],
    trackingPattern: /^SF[A-Z0-9]{8,14}$/i,
    trackingUrl: (awb) => `https://tracker.shadowfax.in/#/track?awb=${encodeURIComponent(awb)}`,
    description: 'Hyperlocal & e-commerce express logistics with same-day and reverse courier network.',
    status: 'active',
  },
  shiprocket: {
    id: 'idW3zCkzQE',
    name: 'Shiprocket',
    code: 'SHIPROCKET',
    domain: 'shiprocket.in',
    logoUrl: 'https://cdn.brandfetch.io/idW3zCkzQE/theme/dark/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idW3zCkzQE/w/400/h/400/theme/dark/icon.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#46237a',
    accentColor: '#9896f0',
    textColor: '#ffffff',
    trackingPrefixes: ['SR', 'SRKT'],
    trackingPattern: /^(SR|SRKT)[A-Z0-9]{8,14}$/i,
    trackingUrl: (awb) => `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`,
    description: 'E-commerce shipping enablement and multi-courier fulfillment orchestration.',
    status: 'integrated',
  },
  xpressbees: {
    id: 'id3Wnmm8UV',
    name: 'Xpressbees',
    code: 'XPRESSBEES',
    domain: 'xpressbees.com',
    logoUrl: 'https://cdn.brandfetch.io/id3Wnmm8UV/w/213/h/35/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/id3Wnmm8UV/w/200/h/200/theme/dark/icon.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#624509',
    accentColor: '#f58220',
    textColor: '#ffffff',
    trackingPrefixes: ['EXP', 'DX', 'XB'],
    trackingPattern: /^(EXP|DX|XB)[A-Z0-9]{8,14}$/i,
    trackingUrl: (awb) => `https://www.xpressbees.com/track?awb=${encodeURIComponent(awb)}`,
    description: 'Fastest growing express logistics company specialized in end-to-end e-commerce supply chain.',
    status: 'active',
  },
  valmo: {
    id: 'valmo-meesho',
    name: 'Valmo (Meesho)',
    code: 'VALMO',
    domain: 'meesho.com',
    logoUrl: 'https://cdn.brandfetch.io/idyeTDctmi/w/200/h/64/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idyeTDctmi/w/800/h/800/theme/dark/icon.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#2c1560',
    accentColor: '#f05a9b',
    textColor: '#ffffff',
    trackingPrefixes: ['VL'],
    trackingPattern: /^VL[0-9A-Z]{8,16}$/i,
    trackingUrl: (awb) => `https://supplier.meesho.com/panel/v3/new/orders/track?awb=${encodeURIComponent(awb)}`,
    description: "Meesho's internal dedicated logistics arm handling direct-to-consumer flyer packaging.",
    status: 'active',
  },
  dtdc: {
    id: 'iddqzROTdw',
    name: 'DTDC Express',
    code: 'DTDC',
    domain: 'dtdc.com',
    logoUrl: 'https://cdn.brandfetch.io/iddqzROTdw/w/660/h/150/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/iddqzROTdw/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#001122',
    accentColor: '#dc0032',
    textColor: '#ffffff',
    trackingPrefixes: ['D', 'Z', 'B', 'K'],
    trackingPattern: /^[DZBK][0-9]{8,10}$/i,
    trackingUrl: (awb) => `https://www.dtdc.in/tracking/tracking_results.asp?trCode=${encodeURIComponent(awb)}`,
    description: 'Pioneer express courier and freight carrier servicing over 10,000 pin codes across India.',
    status: 'supported',
  },
  bluedart: {
    id: 'bluedart-dhl',
    name: 'Blue Dart',
    code: 'BLUEDART',
    domain: 'bluedart.com',
    logoUrl: 'https://cdn.brandfetch.io/idv0ZbfQqf/w/800/h/114/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idv0ZbfQqf/w/200/h/200/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#002D62',
    accentColor: '#ED1C24',
    textColor: '#ffffff',
    trackingPrefixes: ['BLU', '7'],
    trackingPattern: /^(BLU[A-Z0-9]{8,12}|7\d{10})$/i,
    trackingUrl: (awb) => `https://www.bluedart.com/tracking?trackFor=0&trackNo=${encodeURIComponent(awb)}`,
    description: "South Asia's premier express air and integrated transportation and distribution network (DHL Group).",
    status: 'active',
  },
  ecomexpress: {
    id: 'idsMaBN0jb',
    name: 'Ecom Express',
    code: 'ECOM_EXPRESS',
    domain: 'ecomexpress.in',
    logoUrl: 'https://cdn.brandfetch.io/idsMaBN0jb/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idsMaBN0jb/w/820/h/83/theme/light/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#1a1a1a',
    accentColor: '#e30175',
    textColor: '#ffffff',
    trackingPrefixes: ['9', '8'],
    trackingPattern: /^[89]\d{9,12}$/,
    trackingUrl: (awb) => `https://ecomexpress.in/tracking/?awb=${encodeURIComponent(awb)}`,
    description: 'Technology enabled logistics provider specializing in last-mile e-commerce deliveries.',
    status: 'supported',
  },
  fedex: {
    id: 'idVIIZH-LB',
    name: 'FedEx',
    code: 'FEDEX',
    domain: 'fedex.com',
    logoUrl: 'https://cdn.brandfetch.io/idVIIZH-LB/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idVIIZH-LB/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#4D148C',
    accentColor: '#FF6200',
    textColor: '#ffffff',
    trackingPrefixes: ['7', '4', '9'],
    trackingPattern: /^\d{12,14}$/,
    trackingUrl: (awb) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(awb)}`,
    description: 'Global standard for international and express air freight and parcel delivery.',
    status: 'supported',
  },
  dhl: {
    id: 'idv0ZbfQqf',
    name: 'DHL Express',
    code: 'DHL',
    domain: 'dhl.com',
    logoUrl: 'https://cdn.brandfetch.io/idv0ZbfQqf/theme/dark/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idv0ZbfQqf/w/200/h/200/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#FFCC00',
    accentColor: '#D40511',
    textColor: '#191919',
    trackingPrefixes: ['DHL', '10', '11'],
    trackingPattern: /^(DHL\d{10}|\d{10})$/i,
    trackingUrl: (awb) => `https://www.dhl.com/en/express/tracking.html?AWB=${encodeURIComponent(awb)}`,
    description: 'Global leader in courier logistics and express international delivery.',
    status: 'supported',
  },
  ups: {
    id: 'id5aN1Q7um',
    name: 'UPS',
    code: 'UPS',
    domain: 'ups.com',
    logoUrl: 'https://cdn.brandfetch.io/id5aN1Q7um/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/id5aN1Q7um/w/213/h/213/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#351C15',
    accentColor: '#FFC400',
    textColor: '#ffffff',
    trackingPrefixes: ['1Z'],
    trackingPattern: /^1Z[0-9A-Z]{16}$/i,
    trackingUrl: (awb) => `https://www.ups.com/track?tracknum=${encodeURIComponent(awb)}`,
    description: 'Global package delivery and supply chain management logistics provider.',
    status: 'supported',
  },
  ekart: {
    id: 'idWdImNSUt-ekart',
    name: 'Ekart (Flipkart)',
    code: 'EKART',
    domain: 'flipkart.com',
    logoUrl: 'https://cdn.brandfetch.io/idWdImNSUt/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idWdImNSUt/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#1C41D6',
    accentColor: '#FFE51F',
    textColor: '#ffffff',
    trackingPrefixes: ['FMP', 'FMPC'],
    trackingPattern: /^FMPC?[A-Z0-9]{8,14}$/i,
    trackingUrl: (awb) => `https://ekartlogistics.com/shipmenttrack/${encodeURIComponent(awb)}`,
    description: "Flipkart's logistics network powering rapid fulfillment across India.",
    status: 'active',
  },
  amazon: {
    id: 'idawOgYOsG-ats',
    name: 'Amazon Shipping (ATS)',
    code: 'AMAZON_ATS',
    domain: 'amazon.com',
    logoUrl: 'https://cdn.brandfetch.io/idawOgYOsG/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idawOgYOsG/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#000000',
    accentColor: '#FF9900',
    textColor: '#ffffff',
    trackingPrefixes: ['TBA'],
    trackingPattern: /^TBA[0-9]{9,14}$/i,
    trackingUrl: (awb) => `https://track.amazon.in/tracking/${encodeURIComponent(awb)}`,
    description: "Amazon's dedicated transportation services for vendor and marketplace orders.",
    status: 'active',
  },
};

// Brandfetch verified marketplaces
export const MARKETPLACE_REGISTRY: Record<string, MarketplaceBrand> = {
  meesho: {
    id: 'idyeTDctmi',
    name: 'Meesho',
    code: 'MEESHO',
    domain: 'meesho.com',
    logoUrl: 'https://cdn.brandfetch.io/idyeTDctmi/w/200/h/64/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idyeTDctmi/w/800/h/800/theme/dark/icon.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#2c1560',
    accentColor: '#f05a9b',
    textColor: '#ffffff',
    description: "Social commerce & marketplace leader in India with flyer-based barcode scanning.",
  },
  ajio: {
    id: 'idr5xgDFc2',
    name: 'AJIO',
    code: 'AJIO',
    domain: 'ajio.com',
    logoUrl: 'https://cdn.brandfetch.io/idr5xgDFc2/theme/dark/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idr5xgDFc2/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#3c0000',
    accentColor: '#9a0000',
    textColor: '#ffffff',
    description: 'Reliance Retail flagship fashion e-commerce platform with automated WFR and courier receipts.',
  },
  shopify: {
    id: 'idAgPm7IvG',
    name: 'Shopify',
    code: 'SHOPIFY',
    domain: 'shopify.com',
    logoUrl: 'https://cdn.brandfetch.io/idAgPm7IvG/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idAgPm7IvG/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#002E25',
    accentColor: '#95C049',
    textColor: '#ffffff',
    description: 'Global commerce infrastructure powering custom storefronts and order management.',
  },
  flipkart: {
    id: 'idWdImNSUt',
    name: 'Flipkart',
    code: 'FLIPKART',
    domain: 'flipkart.com',
    logoUrl: 'https://cdn.brandfetch.io/idWdImNSUt/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idWdImNSUt/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#1C41D6',
    accentColor: '#FFE51F',
    textColor: '#ffffff',
    description: 'Premier Indian online marketplace integrated with Ekart logistics network.',
  },
  amazon: {
    id: 'idawOgYOsG',
    name: 'Amazon',
    code: 'AMAZON',
    domain: 'amazon.com',
    logoUrl: 'https://cdn.brandfetch.io/idawOgYOsG/theme/light/logo.svg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idawOgYOsG/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#000000',
    accentColor: '#FF9900',
    textColor: '#ffffff',
    description: 'World leading digital marketplace ecosystem supporting multi-channel fulfillment.',
  },
};

/**
 * Intelligently detect carrier from tracking ID or carrier code
 */
export function detectCarrier(rawTrackingId: string | null | undefined): CarrierBrand | null {
  if (!rawTrackingId) return null;
  const tracking = rawTrackingId.trim().toUpperCase();

  if (/^VL[0-9A-Z]{6,}/i.test(tracking)) return CARRIER_REGISTRY.valmo;
  if (/^SF[A-Z0-9]{8,}/i.test(tracking)) return CARRIER_REGISTRY.shadowfax;
  if (/^FMPC?[A-Z0-9]{8,}/i.test(tracking)) return CARRIER_REGISTRY.ekart;
  if (/^TBA[0-9]{9,}/i.test(tracking)) return CARRIER_REGISTRY.amazon;
  if (/^(EXP|DX|XB)[A-Z0-9]{8,}/i.test(tracking)) return CARRIER_REGISTRY.xpressbees;
  if (/^BLU[A-Z0-9]{6,}/i.test(tracking)) return CARRIER_REGISTRY.bluedart;
  if (/^(SR|SRKT)[A-Z0-9]{8,}/i.test(tracking)) return CARRIER_REGISTRY.shiprocket;
  if (/^[DZBK][0-9]{8,10}$/i.test(tracking)) return CARRIER_REGISTRY.dtdc;
  if (/^1Z[0-9A-Z]{16}$/i.test(tracking)) return CARRIER_REGISTRY.ups;
  if (/^DHL[0-9A-Z]{8,}/i.test(tracking)) return CARRIER_REGISTRY.dhl;
  if (/^[89]\d{9,11}$/.test(tracking)) return CARRIER_REGISTRY.ecomexpress;
  if (/^(149\d{10,14}|12\d{10,12}|13\d{10,12}|33\d{10,12}|\d{12,16})$/.test(tracking)) return CARRIER_REGISTRY.delhivery;

  return null;
}

/**
 * Match marketplace by key/name
 */
export function getMarketplaceBrand(marketplace: string | null | undefined): MarketplaceBrand | null {
  if (!marketplace) return null;
  const key = marketplace.toLowerCase().trim();
  if (key.includes('meesho')) return MARKETPLACE_REGISTRY.meesho;
  if (key.includes('ajio')) return MARKETPLACE_REGISTRY.ajio;
  if (key.includes('shopify')) return MARKETPLACE_REGISTRY.shopify;
  if (key.includes('flipkart')) return MARKETPLACE_REGISTRY.flipkart;
  if (key.includes('amazon')) return MARKETPLACE_REGISTRY.amazon;
  return null;
}

// Brandfetch verified payment gateways & checkout integrations
export const PAYMENT_GATEWAY_REGISTRY: Record<string, PaymentGatewayBrand> = {
  gokwik: {
    id: 'idOPkt8Wn5',
    name: 'GoKwik',
    code: 'GOKWIK',
    domain: 'gokwik.co',
    logoUrl: 'https://cdn.brandfetch.io/idOPkt8Wn5/w/800/h/289/theme/light/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idOPkt8Wn5/w/400/h/400/theme/dark/icon.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#004b8d',
    accentColor: '#F09819',
    textColor: '#ffffff',
    description: 'AI-powered checkout enablement, 100% RTO protection suite, and dynamic COD order confirmation.',
    paymentModes: ['prepaid', 'cod', 'upi'],
    settlementCycle: 'T+1 Days',
    portalUrl: 'https://merchant.gokwik.co',
  },
  easebuzz: {
    id: 'id1_ejsPh1',
    name: 'Easebuzz',
    code: 'EASEBUZZ',
    domain: 'easebuzz.in',
    logoUrl: 'https://cdn.brandfetch.io/id1_ejsPh1/w/820/h/199/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/id1_ejsPh1/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#6d44e5',
    accentColor: '#40f9e5',
    textColor: '#ffffff',
    description: 'Full-stack digital payment processing, automated instant refunds, and multi-split vendor settlements.',
    paymentModes: ['prepaid', 'upi', 'netbanking', 'card'],
    settlementCycle: 'T+2 Days',
    portalUrl: 'https://easebuzz.in/login',
  },
  phonepe: {
    id: 'idcE0OdG8i',
    name: 'PhonePe',
    code: 'PHONEPE',
    domain: 'phonepe.com',
    logoUrl: 'https://cdn.brandfetch.io/idcE0OdG8i/w/800/h/218/theme/dark/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idcE0OdG8i/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#361968',
    accentColor: '#C3A0EC',
    textColor: '#ffffff',
    description: "India's leading UPI payments platform with payment links, gateway settlements, and merchant dashboard.",
    paymentModes: ['prepaid', 'upi'],
    settlementCycle: 'T+1 Days',
    portalUrl: 'https://business.phonepe.com',
  },
  razorpay: {
    id: 'idHc4m3b7C',
    name: 'Razorpay',
    code: 'RAZORPAY',
    domain: 'razorpay.com',
    logoUrl: 'https://cdn.brandfetch.io/idHc4m3b7C/w/800/h/170/theme/light/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idHc4m3b7C/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#02042b',
    accentColor: '#286cd5',
    textColor: '#ffffff',
    description: 'Converged payment gateway, recurring subscriptions, UPI Autopay, and instant customer refund rails.',
    paymentModes: ['prepaid', 'upi', 'card', 'netbanking'],
    settlementCycle: 'T+2 Days',
    portalUrl: 'https://dashboard.razorpay.com',
  },
  cashfree: {
    id: 'idLecjUPYL',
    name: 'Cashfree Payments',
    code: 'CASHFREE',
    domain: 'cashfree.com',
    logoUrl: 'https://cdn.brandfetch.io/idLecjUPYL/w/800/h/233/theme/light/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idLecjUPYL/w/400/h/400/theme/dark/icon.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#240253',
    accentColor: '#05C16E',
    textColor: '#ffffff',
    description: 'Banking APIs, bulk payouts engine, automated reconciliation, and instant refund verification.',
    paymentModes: ['prepaid', 'upi', 'netbanking', 'card'],
    settlementCycle: 'T+1 Days',
    portalUrl: 'https://merchant.cashfree.com',
  },
  paytm: {
    id: 'idRNBjXRVq',
    name: 'Paytm',
    code: 'PAYTM',
    domain: 'paytm.com',
    logoUrl: 'https://cdn.brandfetch.io/idRNBjXRVq/w/800/h/254/theme/light/logo.png?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    iconUrl: 'https://cdn.brandfetch.io/idRNBjXRVq/w/400/h/400/theme/dark/icon.jpeg?c=1bxz7nrnjqcuvlb6lc2wbkb2gh18SXdPupo',
    brandColor: '#002970',
    accentColor: '#00baf2',
    textColor: '#ffffff',
    description: 'Digital payments and wallet infrastructure powering online merchant checkouts.',
    paymentModes: ['prepaid', 'upi', 'wallet'],
    settlementCycle: 'T+1 Days',
    portalUrl: 'https://dashboard.paytm.com',
  },
};

/**
 * Detect payment gateway from payment method string or order note
 */
export function detectPaymentGateway(paymentMethodOrGateway: string | null | undefined): PaymentGatewayBrand | null {
  if (!paymentMethodOrGateway) return null;
  const str = paymentMethodOrGateway.toLowerCase().trim();

  if (str.includes('gokwik')) return PAYMENT_GATEWAY_REGISTRY.gokwik;
  if (str.includes('easebuzz') || str.includes('esubuzz') || str.includes('ease_buzz')) return PAYMENT_GATEWAY_REGISTRY.easebuzz;
  if (str.includes('phonepe') || str.includes('phone_pe')) return PAYMENT_GATEWAY_REGISTRY.phonepe;
  if (str.includes('razorpay') || str.includes('rzp')) return PAYMENT_GATEWAY_REGISTRY.razorpay;
  if (str.includes('cashfree')) return PAYMENT_GATEWAY_REGISTRY.cashfree;
  if (str.includes('paytm')) return PAYMENT_GATEWAY_REGISTRY.paytm;

  return null;
}

/**
 * Get payment gateway brand by code
 */
export function getPaymentGateway(code: string | null | undefined): PaymentGatewayBrand | null {
  if (!code) return null;
  const key = code.toLowerCase().trim();
  return PAYMENT_GATEWAY_REGISTRY[key] || null;
}
