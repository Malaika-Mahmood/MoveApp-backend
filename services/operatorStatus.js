const { REQUIRED_OPERATOR_DOCUMENTS } = require("../constants/operatorDocuments");

// An operator's status is DERIVED from their documents and councils, exactly
// the way a driver's is derived from theirs. Nothing sets it by hand.
//
// This lives in its own file rather than in a controller so that both the
// operator's own endpoints and the admin's endpoints can call it without
// requiring each other — a circular require that would leave one of them
// holding an empty module at start-up.
const recomputeOperatorStatus = async (client, operatorId) => {
    const userResult = await client.query(
        "SELECT status FROM users WHERE id = $1 AND role = 'operator'",
        [operatorId]
    );
    const user = userResult.rows[0];
    if (!user) return null;

    // A suspension is an admin decision, not something documents can undo
    if (user.status === "suspended") return "suspended";

    const docs = await client.query(
        "SELECT document_type, status FROM operator_documents WHERE user_id = $1 AND is_current",
        [operatorId]
    );
    const byType = new Map(docs.rows.map((d) => [d.document_type, d.status]));

    const allPresent = REQUIRED_OPERATOR_DOCUMENTS.every((t) => byType.has(t));
    const allApproved = REQUIRED_OPERATOR_DOCUMENTS.every((t) => byType.get(t) === "approved");
    const anyDocRejected = docs.rows.some((d) => d.status === "rejected");

    const councils = await client.query(
        "SELECT status FROM operator_councils WHERE user_id = $1",
        [operatorId]
    );
    const hasCouncil = councils.rows.length > 0;
    const allCouncilsApproved = hasCouncil && councils.rows.every((c) => c.status === "approved");
    const anyCouncilRejected = councils.rows.some((c) => c.status === "rejected");

    let status;

    if (anyDocRejected || anyCouncilRejected) {
        status = "rejected";
    } else if (allApproved && allCouncilsApproved) {
        // Every required document approved, and at least one council licence
        // approved — an operator with no council is not licensed to operate
        status = "approved";
    } else if (allPresent && hasCouncil) {
        status = "pending_verification";
    } else {
        status = "account_created";
    }

    await client.query(
        "UPDATE users SET status = $1, updated_at = NOW() WHERE id = $2",
        [status, operatorId]
    );

    return status;
};

module.exports = { recomputeOperatorStatus };