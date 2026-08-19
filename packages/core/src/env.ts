import { z } from "zod";

const hexKey64 = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be exactly 64 hex characters (32 bytes) — generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");

const nonEmpty = (label: string) => z.string().trim().min(1, `${label} is required`);

const boolFromString = z
  .string()
  .optional()
  .transform((v) => v === "true" || v === "1")
  .pipe(z.boolean());

const envObjectSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_BASE_URL: z.string().url(),
  DASHBOARD_SHARED_SECRET: nonEmpty("DASHBOARD_SHARED_SECRET"),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty("SUPABASE_SERVICE_ROLE_KEY"),
  SUPABASE_ANON_KEY: z.string().optional().default(""),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// or postgresql:// connection string"),
  DB_POOL_MAX: z.coerce.number().int().positive().default(5),
  SUPABASE_STORAGE_BUCKET: nonEmpty("SUPABASE_STORAGE_BUCKET").default("instagram-media"),

  META_APP_ID: nonEmpty("META_APP_ID"),
  META_APP_SECRET: nonEmpty("META_APP_SECRET"),
  META_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/, "expected format vNN.N, e.g. v23.0"),
  META_API_BASE: z.string().url(),
  META_IG_USER_ID: nonEmpty("META_IG_USER_ID"),
  META_LONG_LIVED_ACCESS_TOKEN: z.string().optional().default(""),
  META_OAUTH_REDIRECT_URI: z.string().url(),
  META_WEBHOOK_VERIFY_TOKEN: nonEmpty("META_WEBHOOK_VERIFY_TOKEN"),

  ENCRYPTION_KEY: hexKey64,
  BRIDGE_SHARED_SECRET: nonEmpty("BRIDGE_SHARED_SECRET"),

  OPENREPLY_DASHBOARD_URL: z.string().url().default("http://localhost:3100"),

  QUEUE_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_HEALTH_PORT: z.coerce.number().int().positive().default(8080),

  MOCK_META: boolFromString,
  MOCK_META_PORT: z.coerce.number().int().positive().default(8787),

  // AI / caption generation (packages/ai) — off by default. The plan is
  // explicit (section 7) that Bedrock must never sit in the critical
  // publishing path: this app runs identically whether AI_ENABLED is
  // true or false. When true, AWS_REGION and BEDROCK_MODEL_ID become
  // required; AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are NOT required
  // even then — the AWS SDK also accepts credentials from a shared
  // ~/.aws/credentials profile or an IAM role, so leave them blank if
  // you're using one of those instead.
  AI_ENABLED: boolFromString,
  AWS_REGION: z.string().optional().default(""),
  AWS_ACCESS_KEY_ID: z.string().optional().default(""),
  AWS_SECRET_ACCESS_KEY: z.string().optional().default(""),
  BEDROCK_MODEL_ID: z.string().optional().default("")
});

export const envSchema = envObjectSchema.superRefine((env, ctx) => {
  if (env.AI_ENABLED) {
    if (!env.AWS_REGION) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["AWS_REGION"], message: "required when AI_ENABLED=true" });
    }
    if (!env.BEDROCK_MODEL_ID) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["BEDROCK_MODEL_ID"],
        message: "required when AI_ENABLED=true — check available model IDs for your AWS account/region with `aws bedrock list-foundation-models`"
      });
    }
  }
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Parses and validates process.env once per process. Throws a
 * readable, aggregated error (not a stack trace on the first missing
 * key) so a misconfigured .env fails loudly at boot rather than
 * halfway through a Meta API call.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  const result = envSchema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`);
    throw new Error(
      `Invalid environment configuration.\n${lines.join("\n")}\n\nCopy .env.example to .env and fill in the missing values, then run "npm run check-env" to verify.`
    );
  }

  cached = result.data;
  return cached;
}

/** For tests only — clears the memoized env so a fresh source can be loaded. */
export function __resetEnvCacheForTests(): void {
  cached = undefined;
}
