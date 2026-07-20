import type { AuthConfig } from "convex/server";

const issuer = process.env.DROPSHIP_AI_AUTH_ISSUER;
const applicationID = process.env.DROPSHIP_AI_AUTH_AUDIENCE;

if (!issuer || !applicationID) {
  throw new Error("DROPSHIP_AI_AUTH_ISSUER and DROPSHIP_AI_AUTH_AUDIENCE must be configured in Convex");
}

export default {
  providers: [{
    type: "customJwt",
    issuer,
    applicationID,
    jwks: `${issuer}/api/auth/jwks`,
    algorithm: "RS256",
  }],
} satisfies AuthConfig;
