// src/server/index.ts
import dotenv from "dotenv";
dotenv.config();
console.log("✅ DATABASE_URL value at runtime:", process.env.DATABASE_URL);
import express from "express";
import path from "path";
import cookieParser from "cookie-parser";
import logger from "morgan";
import flash from "express-flash";
import createError from "http-errors";
import session from "express-session";
import passport from "passport";
import { Pool } from "pg";

// ⬇ CommonJS fallback for connect-pg-simple
import connectPgSimple from "connect-pg-simple";
const pgSession = connectPgSimple(session);

// ✅ Set up Postgres connection directly
const pgPool = new Pool({
    connectionString: "postgres://mural_user:mural123@localhost:5432/mural_dev"
});


console.log("🔐 Session store using pool:", process.env.DATABASE_URL);

const app = express();

/* ---------- view engine ---------- */
app.set("views", path.join(__dirname, "../views"));
app.set("view engine", "ejs");

import expressLayouts from "express-ejs-layouts";
app.use(expressLayouts);

app.set("layout", "partials/_layout"); // sets the default layout globally
// Ensure every render call includes default layout locals
app.use((req, res, next) => {
    const originalRender = res.render.bind(res);
    res.render = (view: string, options?: any, callback?: (err: Error, html: string) => void): void => {
        if (typeof options === "function") {
            // Handle (view, callback) signature
            return originalRender(view, options);
        }

        // Handle (view, options, callback)
        options = options || {};

        // Only set default layout if layout is not explicitly set to false
        if (options.layout !== false) {
            options.layout = options.layout ?? "partials/_layout";
        }

        options.title = options.title ?? "Untitled";
        options.route = options.route ?? "";

        return originalRender(view, options, callback);
    };
    next();
});


/* ---------- middleware ---------- */
app.use(logger("dev"));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, "../public")));

// ✅ Serve local /images directory
const localImagesPath = path.join(__dirname, "../../images");
app.use("/images", express.static(localImagesPath));

/* ---------- sessions ---------- */
try {
    pgPool.query("SELECT current_database()").then(res => {
        console.log("🧪 Connected DB for session store:", res.rows[0].current_database);
    });
    app.use(
        session({
            store: new pgSession({
                pool: pgPool,
                tableName: "session",
                createTableIfMissing: true,
            }),
            secret: process.env.SESSION_SECRET || "dev_secret",
            resave: false,
            saveUninitialized: false,
            cookie: {
                maxAge: 30 * 24 * 60 * 60 * 1000,
                secure: process.env.NODE_ENV === "production",
            },
        })
    );
} catch (err) {
    console.error("❌ Error setting up session middleware:", err);
}

/* ---------- auth ---------- */
app.use(passport.initialize());
app.use(passport.session());

app.use(flash());

/* ---------- routes ---------- */
import homeRouter from "./routes/home";
import apiRouter from "./routes/api";
import imageRouter from "./routes/image";

app.use("/", homeRouter);
app.use("/", imageRouter);
app.use("/api", apiRouter);

/* ---------- 404 ---------- */
app.use((_req, _res, next) => next(createError(404)));

/* ---------- error handler ---------- */
app.use((err: any, req: any, res: any, _next: any) => {
    res.locals.message = err.message;
    res.locals.error = req.app.get("env") === "development" ? err : {};
    res.status(err.status || 500);
    res.render("error");
});

/* ---------- server ---------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
});

