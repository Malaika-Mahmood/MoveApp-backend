// Who is allowed to see whose contact details.
//
// The rule the CEO set: an operator must not see a driver's phone number or
// email address, and a driver must not see the operator's. They will talk
// through in-app chat instead.
//
// Everything else about the driver stays visible to the operator — name, date
// of birth, address, National Insurance number, and every document. Without
// those the operator cannot check the passport against the licence, which is
// the entire job. Masking the contact details protects the driver from being
// approached outside the app; masking the identity details would just stop
// verification working.
//
// The admin sees everything. When DVSA, an insurer or the police ask, the
// company has to be able to answer, and it cannot do that from a masked record.
//
// This lives in its own small file so that every endpoint asks the same
// question in the same way. A new endpoint that forgets to mask is how this
// kind of rule quietly stops being true.

// A driver looking at their own record is not "someone else" — they see their
// own number, obviously.
const canSeeDriverContact = (viewerRole) =>
    viewerRole === "admin" || viewerRole === "driver";

const canSeeOperatorContact = (viewerRole) =>
    viewerRole === "admin" || viewerRole === "operator";

// Returns a copy with the contact fields blanked when the viewer is not
// allowed to see them.
//
// The keys stay in the response set to null rather than disappearing, so the
// app never has to handle a missing field — and `contact_masked` tells it to
// show "Hidden" instead of an empty line, which is the difference between a
// screen that looks deliberate and one that looks broken.
const maskDriverContact = (driver, viewerRole) => {
    if (!driver) return driver;

    if (canSeeDriverContact(viewerRole)) {
        return { ...driver, contact_masked: false };
    }

    return {
        ...driver,
        email: null,
        phone: null,
        contact_masked: true
    };
};

const maskOperatorContact = (operator, viewerRole) => {
    if (!operator) return operator;

    if (canSeeOperatorContact(viewerRole)) {
        return { ...operator, contact_masked: false };
    }

    return {
        ...operator,
        email: null,
        phone: null,
        contact_masked: true
    };
};

module.exports = {
    canSeeDriverContact,
    canSeeOperatorContact,
    maskDriverContact,
    maskOperatorContact
};