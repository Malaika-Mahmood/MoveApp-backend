const pool = require("../config/db");

// The bell icon. Every role uses these three endpoints — a notification knows
// who it belongs to, so there is nothing role-specific here.
//
// The id always comes from the token. Nobody can read or clear anybody else's
// notifications by changing a number in the URL.

const toNotification = (n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    data: n.data,
    is_read: n.read_at !== null,
    read_at: n.read_at,
    created_at: n.created_at
});

// GET /api/v1/notifications?page=1&limit=20&unread=true
const getMyNotifications = async (req, res) => {
    try {
        const page = Math.max(1, parseInt(req.query.page, 10) || 1);
        const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const unreadOnly = req.query.unread === "true";

        const where = unreadOnly
            ? "user_id = $1 AND read_at IS NULL"
            : "user_id = $1";

        const rows = await pool.query(
            `SELECT * FROM notifications
             WHERE ${where}
             ORDER BY created_at DESC
             LIMIT $2 OFFSET $3`,
            [req.user.id, limit, offset]
        );

        const counts = await pool.query(
            `SELECT COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE read_at IS NULL)::int AS unread
             FROM notifications
             WHERE user_id = $1`,
            [req.user.id]
        );

        const { total, unread } = counts.rows[0];

        res.status(200).json({
            notifications: rows.rows.map(toNotification),

            // The badge number, on every response. The app never has to make a
            // second call to find out what to draw on the bell.
            unread_count: unread,

            pagination: {
                page,
                limit,
                total,
                total_pages: Math.max(1, Math.ceil(total / limit))
            }
        });

    } catch (error) {
        console.error("Error in getMyNotifications:", error);
        res.status(500).json({ message: "Something went wrong while fetching notifications" });
    }
};

// PATCH /api/v1/notifications/:id/read
const markAsRead = async (req, res) => {
    try {
        const { id } = req.params;

        if (!/^\d+$/.test(id)) {
            return res.status(400).json({ message: "Invalid notification id" });
        }

        // The user_id in the WHERE is the permission check. A notification
        // belonging to somebody else simply does not match, so it returns 404
        // rather than 403 — telling a stranger that a row exists but is not
        // theirs is itself a small leak.
        const updated = await pool.query(
            `UPDATE notifications
             SET read_at = COALESCE(read_at, NOW())
             WHERE id = $1 AND user_id = $2
             RETURNING *`,
            [id, req.user.id]
        );

        if (updated.rows.length === 0) {
            return res.status(404).json({
                message: "Notification not found",
                error_code: "NOT_FOUND"
            });
        }

        const unread = await pool.query(
            "SELECT COUNT(*)::int AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL",
            [req.user.id]
        );

        res.status(200).json({
            message: "Marked as read",
            notification: toNotification(updated.rows[0]),
            unread_count: unread.rows[0].unread
        });

    } catch (error) {
        console.error("Error in markAsRead:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

// PATCH /api/v1/notifications/read-all
const markAllAsRead = async (req, res) => {
    try {
        const updated = await pool.query(
            `UPDATE notifications
             SET read_at = NOW()
             WHERE user_id = $1 AND read_at IS NULL
             RETURNING id`,
            [req.user.id]
        );

        res.status(200).json({
            message: "All notifications marked as read",
            marked: updated.rows.length,
            unread_count: 0
        });

    } catch (error) {
        console.error("Error in markAllAsRead:", error);
        res.status(500).json({ message: "Something went wrong" });
    }
};

module.exports = { getMyNotifications, markAsRead, markAllAsRead, toNotification };