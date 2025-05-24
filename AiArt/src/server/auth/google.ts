import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { pool } from "../../config/database";

passport.serializeUser((user: any, done) => done(null, user.id));
passport.deserializeUser(async (id: number, done) => {
    const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1`, [id]);
    done(null, rows[0] ?? false);
});

passport.use(
    new GoogleStrategy(
        {
            clientID:     process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            callbackURL:  "/auth/google/callback",
        },
        async (_accessToken, _refreshToken, profile, done) => {
            const email = profile.emails?.[0].value;
            const { rows } = await pool.query(
                `INSERT INTO users (username,email,password_hash)
         VALUES ($1,$2,'oauth') ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email
         RETURNING *`,
                [profile.displayName, email]
            );
            done(null, rows[0]);
        }
    )
);

// tiny router
import express from "express";
const router = express.Router();

router.get("/google", passport.authenticate("google", { scope: ["email","profile"] }));
router.get("/google/callback",
    passport.authenticate("google", { failureRedirect: "/" }),
    (_req,res) => res.redirect("/")
);

export default router;
