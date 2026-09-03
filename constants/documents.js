// Every list of document types lives here. Previously the driver list sat in
// documentController and the operator code could not see it, which is how the
// "approved with 2 of 10 documents" bug survived.

const REQUIRED_DRIVER_DOCUMENTS = [
    "nic_front",
    "nic_back",
    "pco_licence_front",
    "pco_licence_back",
    "driving_licence_front",
    "driving_licence_back",
    "passport_photo",
    "selfie_front",
    "selfie_left",
    "selfie_right"
];

// Shown with a "Skip now" button. Never blocks verification.
const OPTIONAL_DRIVER_DOCUMENTS = [
    "pco_paper_part"
];

const ALL_DRIVER_DOCUMENTS = [...REQUIRED_DRIVER_DOCUMENTS, ...OPTIONAL_DRIVER_DOCUMENTS];

const REQUIRED_VEHICLE_DOCUMENTS = [
    "pco_vehicle_paper",
    "v5_logbook",
    "mot_road_tax",
    "car_insurance",
    "valid_mot",
    "photo_front",
    "photo_back",
    "photo_interior"
];

const ALL_VEHICLE_DOCUMENTS = [...REQUIRED_VEHICLE_DOCUMENTS];

// Documents that carry an expiry date. The operator fills these in while
// approving — they are reading the document anyway.
//
// A photo or a National Insurance card does not expire, so asking for a date
// on those would just be noise.
const DRIVER_DOCUMENTS_WITH_EXPIRY = [
    "driving_licence_front",
    "pco_licence_front",
    "pco_paper_part"
];

const VEHICLE_DOCUMENTS_WITH_EXPIRY = [
    "pco_vehicle_paper",
    "mot_road_tax",
    "car_insurance",
    "valid_mot"
];

const documentNeedsExpiry = (type) =>
    DRIVER_DOCUMENTS_WITH_EXPIRY.includes(type) || VEHICLE_DOCUMENTS_WITH_EXPIRY.includes(type);

// Where the file came from on the phone
const DOCUMENT_SOURCES = ["scan", "gallery", "pdf"];

// Human labels, so the app does not have to hard-code its own copy of these
// and drift out of step with the backend.
const DOCUMENT_LABELS = {
    nic_front: "National Insurance — front",
    nic_back: "National Insurance — back",
    pco_licence_front: "PCO licence — front",
    pco_licence_back: "PCO licence — back",
    driving_licence_front: "Driving licence — front",
    driving_licence_back: "Driving licence — back",
    passport_photo: "Passport photo",
    selfie_front: "Selfie — facing forward",
    selfie_left: "Selfie — turned left",
    selfie_right: "Selfie — turned right",
    pco_paper_part: "PCO paper counterpart (optional)",

    pco_vehicle_paper: "PCO vehicle licence",
    v5_logbook: "V5 logbook",
    mot_road_tax: "Road tax",
    car_insurance: "Insurance certificate",
    valid_mot: "Valid MOT",
    photo_front: "Vehicle photo — front",
    photo_back: "Vehicle photo — back",
    photo_interior: "Vehicle photo — interior"
};

module.exports = {
    REQUIRED_DRIVER_DOCUMENTS,
    OPTIONAL_DRIVER_DOCUMENTS,
    ALL_DRIVER_DOCUMENTS,
    REQUIRED_VEHICLE_DOCUMENTS,
    ALL_VEHICLE_DOCUMENTS,
    DRIVER_DOCUMENTS_WITH_EXPIRY,
    VEHICLE_DOCUMENTS_WITH_EXPIRY,
    documentNeedsExpiry,
    DOCUMENT_SOURCES,
    DOCUMENT_LABELS
};