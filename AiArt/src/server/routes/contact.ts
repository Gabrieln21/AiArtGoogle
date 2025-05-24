/**
 * /contact — simple contact form + POST handler
 */
import express from "express";
import nodemailer from "nodemailer";        // optional (npm i nodemailer)

const router = express.Router();

// GET page
router.get("/contact", (_req, res) => {
    res.render("contact", { title: "Contact", route: "contact" });
});

// POST form
router.post("/contact", async (req, res, next) => {
    try {
        const { name = "", email = "", message = "" } = req.body ?? {};

        // TODO: replace with real mail transport or DB store
        const transporter = nodemailer.createTransport({ sendmail: true });
        await transporter.sendMail({
            from: `"${name}" <${email}>`,
            to:   "hello@example.com",
            subject: "Portfolio contact form",
            text: message
        });

        req.flash?.("success", "Message sent – thank you!");
        res.redirect("/contact");
    } catch (err) { next(err); }
});

export default router;
