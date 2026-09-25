// Every list of document types lives here. Previously the driver list sat in
// documentController and the operator code could not see it, which is how the
// "approved with 2 of 10 documents" bug survived.

// The National Insurance document is gone — the driver types the number
// instead, now on the Documents screen rather than Personal Information, and
// the operator checks it against the licence. There is no ni_front / ni_back
// upload.
//
// There is now ONE selfie, not three. The phone captures it live and scans the
// face from every angle during that capture, so what arrives here is a single
// verified image rather than three separate photographs the driver could have
// taken from a gallery. It is taken after login, on its own screen, which is
// why it does not appear on the document upload screens.
const REQUIRED_DRIVER_DOCUMENTS = [
    "pco_licence_front",
    "pco_licence_back",
    "driving_licence_front",
    "driving_licence_back",
    "passport_photo",
    "selfie"
];

// Shown with a "Skip now" button. Never blocks verification.
const OPTIONAL_DRIVER_DOCUMENTS = [
    "passport_copy",
    "private_hire_paper_part"
];

// -----------------------------------------------------------------------------
// Additional documents — "choose any 2"
// -----------------------------------------------------------------------------
// Step 2 of the document screens, added 25 September.
//
// These are NOT optional and they are NOT individually required. The rule is a
// count: any two of them, approved. That is a third kind of requirement, which
// is why it needs its own list rather than being squeezed into the two above —
// "required" means every one of them, and neither of those lists can express
// "two of these nine".
//
// The two groups exist so the app can draw its two headings. The backend does
// NOT enforce one from each: the CEO's rule is any two, from anywhere.
// If that is ever tightened, this is the file it changes in.
const ADDRESS_PROOF_DOCUMENTS = [
    "addr_bank_building_society",
    "addr_utility_bill",
    "addr_credit_card_bill",
    "addr_bank_statement",
    "addr_council_tax",
    "addr_mortgage_statement",
    "addr_hmrc_document"
];

// The photocard driving licence is here even though the driving licence is
// already required above, and it is not a duplicate: the required pair is the
// paper counterpart, this is the modern plastic card. Two different documents
// that happen to share a name.
//
// The passport is deliberately NOT here. It is the optional "Passport copy" on
// step 1 and appears once, in one place.
const ID_PROOF_DOCUMENTS = [
    "id_photocard_licence",
    "id_uk_eea_national_id"
];

const ADDITIONAL_DRIVER_DOCUMENTS = [
    ...ADDRESS_PROOF_DOCUMENTS,
    ...ID_PROOF_DOCUMENTS
];

// How many of the above a driver must have approved before they can work.
const MIN_ADDITIONAL_DOCUMENTS = 2;

// What the app needs to draw step 2: the headings, and which types sit under
// each. Sent from here so the two sides cannot drift apart.
const ADDITIONAL_DOCUMENT_GROUPS = [
    {
        key: "address_proof",
        label: "Address proof",
        types: ADDRESS_PROOF_DOCUMENTS
    },
    {
        key: "id_proof",
        label: "ID proof",
        types: ID_PROOF_DOCUMENTS
    }
];

const ALL_DRIVER_DOCUMENTS = [
    ...REQUIRED_DRIVER_DOCUMENTS,
    ...OPTIONAL_DRIVER_DOCUMENTS,
    ...ADDITIONAL_DRIVER_DOCUMENTS
];

const REQUIRED_VEHICLE_DOCUMENTS = [
    "pco_vehicle_paper",
    "v5_logbook",
    "mot_road_tax",
    "car_insurance",
    "mot_licence",
    "photo_front",
    "photo_back",
    "photo_interior"
];

// Only applies when the vehicle is rented or driven with the owner's
// permission, so it never blocks verification.
const OPTIONAL_VEHICLE_DOCUMENTS = [
    "rental_agreement"
];

const ALL_VEHICLE_DOCUMENTS = [...REQUIRED_VEHICLE_DOCUMENTS, ...OPTIONAL_VEHICLE_DOCUMENTS];

// Documents that carry an expiry date. The operator fills these in while
// approving — they are reading the document anyway.
//
// A photo or a National Insurance letter does not expire, so asking for a date
// on those would just be noise.
//
// The additional documents are not here either, and that is a decision rather
// than an oversight. The screens say "issued within the last 3 months" — that
// is a date the document was ISSUED, not one it expires on, and it is the
// opposite end of the same idea. The operator reads it off the page while
// approving, which is what they were told to do. If that ever needs enforcing,
// it wants its own `issued_on` column, not this list.
const DRIVER_DOCUMENTS_WITH_EXPIRY = [
    "driving_licence_front",
    "pco_licence_front",
    "private_hire_paper_part"
];

const VEHICLE_DOCUMENTS_WITH_EXPIRY = [
    "pco_vehicle_paper",
    "mot_road_tax",
    "car_insurance",
    "mot_licence"
];

const documentNeedsExpiry = (type) =>
    DRIVER_DOCUMENTS_WITH_EXPIRY.includes(type) || VEHICLE_DOCUMENTS_WITH_EXPIRY.includes(type);

// Kept out of the PDF pack — the selfies exist so an operator can match the
// face against the identity documents inside the app. They are not part of a
// document pack anyone would send on.
const DOCUMENTS_EXCLUDED_FROM_PDF = [
    "selfie"
];

// Where the file came from on the phone
const DOCUMENT_SOURCES = ["scan", "gallery", "pdf"];

// Human labels, so the app does not have to hard-code its own copy of these
// and drift out of step with the backend.
const DOCUMENT_LABELS = {
    pco_licence_front: "PCO licence — front",
    pco_licence_back: "PCO licence — back",
    driving_licence_front: "Driving licence — front",
    driving_licence_back: "Driving licence — back",
    passport_photo: "Passport size photo",
    selfie: "Live selfie",
    passport_copy: "Passport copy (optional)",
    private_hire_paper_part: "Private hire paper part (optional)",

    addr_bank_building_society: "Bank / building society statement",
    addr_utility_bill: "Utility bill",
    addr_credit_card_bill: "Credit card bill",
    addr_bank_statement: "Bank statement",
    addr_council_tax: "Council tax bill",
    addr_mortgage_statement: "Mortgage statement",
    addr_hmrc_document: "Official HMRC document (P45 / P60 / tax notification)",
    id_photocard_licence: "Photocard driving licence",
    id_uk_eea_national_id: "UK / EEA national ID card",

    pco_vehicle_paper: "PCO vehicle licence",
    v5_logbook: "V5 logbook (V5C)",
    mot_road_tax: "MOT road tax",
    car_insurance: "Car insurance",
    mot_licence: "MOT licence",
    photo_front: "Vehicle photo — front",
    photo_back: "Vehicle photo — rear",
    photo_interior: "Vehicle photo — interior",
    rental_agreement: "Rental agreement / permission (optional)"
};

// How recent each additional document has to be. Shown on the screen so the
// driver knows what to fetch; NOT checked by the server — the operator reads
// the date while approving. Here rather than in the app so both sides say the
// same thing.
const DOCUMENT_RECENCY_HINTS = {
    addr_bank_building_society: "Issued within the last 3 months",
    addr_utility_bill: "Issued within the last 3 months",
    addr_credit_card_bill: "Issued within the last 3 months",
    addr_bank_statement: "Issued within the last 3 months",
    addr_council_tax: "Issued within the last 12 months",
    addr_mortgage_statement: "Issued within the last 3 months",
    addr_hmrc_document: "Issued within the last 12 months",
    id_photocard_licence: "Must be current and signed",
    id_uk_eea_national_id: "Must be current"
};

module.exports = {
    REQUIRED_DRIVER_DOCUMENTS,
    OPTIONAL_DRIVER_DOCUMENTS,

    ADDRESS_PROOF_DOCUMENTS,
    ID_PROOF_DOCUMENTS,
    ADDITIONAL_DRIVER_DOCUMENTS,
    ADDITIONAL_DOCUMENT_GROUPS,
    MIN_ADDITIONAL_DOCUMENTS,

    ALL_DRIVER_DOCUMENTS,
    REQUIRED_VEHICLE_DOCUMENTS,
    OPTIONAL_VEHICLE_DOCUMENTS,
    ALL_VEHICLE_DOCUMENTS,
    DRIVER_DOCUMENTS_WITH_EXPIRY,
    VEHICLE_DOCUMENTS_WITH_EXPIRY,
    DOCUMENTS_EXCLUDED_FROM_PDF,
    documentNeedsExpiry,
    DOCUMENT_SOURCES,
    DOCUMENT_LABELS,
    DOCUMENT_RECENCY_HINTS
};