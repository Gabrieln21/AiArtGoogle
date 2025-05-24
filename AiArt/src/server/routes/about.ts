/**
 * /about  — Artist bio page
 */
import express from "express";
const router = express.Router();

router.get("/about", (_req, res) => {
    res.render("about", { title: "About", route: "about" });
});

export default router;
