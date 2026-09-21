const express = require("express");
const router = express.Router();

const {
    getMe,
    updatePersonalInfo,
    requestContact,
    getShareCode,
    changeSharePin,
    listAccessRequests,
    decideAccessRequest
} = require("../controllers/driverController");
const {
    uploadDocument,
    getMyDocuments,
    getMyDocumentsPdf
} = require("../controllers/documentController");
const {
    setOnline,
    listMyOffers,
    respondToOffer,
    listAvailableJobs,
    placeBid,
    withdrawBid,
    listMyBids,
    listMyJobs,
    getMyJob,
    updateJobStatus
} = require("../controllers/driverJobController");
const authenticate = require("../middleware/authenticate");
const uploadFile = require("../middleware/uploadFile");

// Everything here is about "the driver who is logged in". The id always comes
// from the token, never from the URL or body — that is what stops one driver
// reading or editing another driver's records.

// Profile
router.get("/me", authenticate, getMe);
router.patch("/me/personal", authenticate, updatePersonalInfo);

// Documents
router.post("/me/documents", authenticate, uploadFile("file"), uploadDocument);
router.get("/me/documents", authenticate, getMyDocuments);
router.get("/me/documents/pdf", authenticate, getMyDocumentsPdf);

// Contact
// The driver cannot see the operator's number, so this asks the operator to
// get in touch instead.
router.post("/me/contact-request", authenticate, requestContact);

// Share code
//
// The driver's own ID and PIN, and the requests that arrive because of them.
// "/me/share-code/pin" is declared before nothing in particular, but the fixed
// path stays above the parameterised one below out of habit.
router.get("/me/share-code", authenticate, getShareCode);
router.post("/me/share-code/pin", authenticate, changeSharePin);

router.get("/me/access-requests", authenticate, listAccessRequests);
router.patch("/me/access-requests/:id", authenticate, decideAccessRequest);

// Work
//
// Every one of these is "the driver who is logged in" — no driver id appears
// in any path, so there is no shape of request that could reach another
// driver's jobs.
//
// A driver locked out by an expired document is turned away from these
// individually rather than by a blanket middleware, because the SAME token
// must still reach the document screens above. That was the point of letting
// them in at all.
router.patch("/me/online", authenticate, setOnline);

router.get("/me/offers", authenticate, listMyOffers);
router.patch("/me/offers/:id", authenticate, respondToOffer);

router.get("/me/available-jobs", authenticate, listAvailableJobs);

// Bidding replaced claiming on 21 September. A bid tells the operator the
// driver is willing, at a price where there is one; it does not give them the
// job. Only the operator assigns.
//
// The old POST .../claim is gone rather than kept as an alias — an endpoint
// whose name promises the job and no longer delivers it is worse than a 404.
router.post("/me/available-jobs/:id/bid", authenticate, placeBid);

router.get("/me/bids", authenticate, listMyBids);
router.delete("/me/bids/:id", authenticate, withdrawBid);

router.get("/me/jobs", authenticate, listMyJobs);
router.get("/me/jobs/:id", authenticate, getMyJob);
router.patch("/me/jobs/:id/status", authenticate, updateJobStatus);

// REMOVED: PATCH /me/type — internal vs external no longer exists.

module.exports = router;