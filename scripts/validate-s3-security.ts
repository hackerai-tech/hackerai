#!/usr/bin/env ts-node
/**
 * S3 Security Validation Script
 *
 * This script validates the S3 configuration and security settings.
 * It checks:
 * - Environment variables are properly configured
 * - AWS credentials are valid and loaded
 * - S3 bucket is accessible
 * - Presigned URL generation works
 * - Security best practices are documented
 *
 * Usage:
 *   pnpm s3:validate
 *   or
 *   npx ts-node scripts/validate-s3-security.ts
 */

import * as dotenv from "dotenv";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  GetBucketCorsCommand,
  GetBucketVersioningCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Load environment variables
dotenv.config({ path: ".env.local" });

export interface ValidationResult {
  name: string;
  passed: boolean;
  message: string;
  warning?: string;
}

const results: ValidationResult[] = [];

const WORKSPACE_BUCKET_ENV_BY_REGION = {
  "us-east-1": "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_US_EAST_1",
  "us-west-2": "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_US_WEST_2",
  "eu-west-1": "AWS_LAMBDA_MICROVM_WORKSPACE_BUCKET_EU_WEST_1",
} as const;

type WorkspaceRegion = keyof typeof WORKSPACE_BUCKET_ENV_BY_REGION;
type ReadWorkspaceBucketVersioning = (
  region: WorkspaceRegion,
  bucketName: string,
) => Promise<string | undefined>;

/**
 * Log validation result with colored output
 */
function logResult(result: ValidationResult): void {
  const icon = result.passed ? "✅" : "❌";
  console.log(`${icon} ${result.name}`);
  console.log(`   ${result.message}`);
  if (result.warning) {
    console.log(`   ⚠️  ${result.warning}`);
  }
  console.log();
}

/**
 * Test 1: Validate environment variables
 */
function validateEnvironmentVariables(): ValidationResult {
  const requiredVars = [
    "AWS_S3_ACCESS_KEY_ID",
    "AWS_S3_SECRET_ACCESS_KEY",
    "AWS_S3_REGION",
    "AWS_S3_BUCKET_NAME",
  ];

  const missing: string[] = [];
  const present: string[] = [];

  for (const varName of requiredVars) {
    if (!process.env[varName]) {
      missing.push(varName);
    } else {
      present.push(varName);
    }
  }

  if (missing.length > 0) {
    return {
      name: "Environment Variables",
      passed: false,
      message: `Missing required environment variables: ${missing.join(", ")}. Please add them to .env.local`,
    };
  }

  return {
    name: "Environment Variables",
    passed: true,
    message: `All required environment variables are set: ${present.join(", ")}`,
  };
}

/**
 * Test 2: Validate AWS credentials and S3 client initialization
 */
async function validateS3Client(): Promise<ValidationResult> {
  try {
    const s3Client = new S3Client({
      region: process.env.AWS_S3_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
      },
    });

    // Test bucket access with HeadBucket
    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    await s3Client.send(
      new HeadBucketCommand({
        Bucket: bucketName,
      }),
    );

    return {
      name: "S3 Client & Credentials",
      passed: true,
      message: `S3 client initialized successfully. Bucket "${bucketName}" is accessible.`,
    };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      name: "S3 Client & Credentials",
      passed: false,
      message: `Failed to initialize S3 client or access bucket: ${errorMessage}`,
    };
  }
}

/**
 * Test 3: Validate bucket encryption
 */
async function validateBucketEncryption(): Promise<ValidationResult> {
  try {
    const s3Client = new S3Client({
      region: process.env.AWS_S3_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
      },
    });

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const response = await s3Client.send(
      new GetBucketEncryptionCommand({
        Bucket: bucketName,
      }),
    );

    const hasEncryption =
      response.ServerSideEncryptionConfiguration?.Rules &&
      response.ServerSideEncryptionConfiguration.Rules.length > 0;

    if (hasEncryption) {
      const algorithm =
        response.ServerSideEncryptionConfiguration!.Rules![0]
          .ApplyServerSideEncryptionByDefault?.SSEAlgorithm;
      return {
        name: "Bucket Encryption",
        passed: true,
        message: `Bucket encryption is enabled with algorithm: ${algorithm}`,
      };
    } else {
      return {
        name: "Bucket Encryption",
        passed: false,
        message: "Bucket encryption is not enabled.",
        warning:
          "It is recommended to enable default encryption (AES256 or aws:kms) for security.",
      };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    // Some AWS accounts may not have permission to check encryption
    if (errorMessage.includes("Access Denied")) {
      return {
        name: "Bucket Encryption",
        passed: true,
        message: "Cannot verify encryption (Access Denied).",
        warning:
          "Please manually verify that default encryption is enabled in AWS Console.",
      };
    }

    return {
      name: "Bucket Encryption",
      passed: false,
      message: `Failed to check bucket encryption: ${errorMessage}`,
    };
  }
}

/**
 * Test 4: Validate public access is blocked
 */
async function validatePublicAccessBlock(): Promise<ValidationResult> {
  try {
    const s3Client = new S3Client({
      region: process.env.AWS_S3_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
      },
    });

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const response = await s3Client.send(
      new GetPublicAccessBlockCommand({
        Bucket: bucketName,
      }),
    );

    const config = response.PublicAccessBlockConfiguration;
    const allBlocked =
      config?.BlockPublicAcls &&
      config?.BlockPublicPolicy &&
      config?.IgnorePublicAcls &&
      config?.RestrictPublicBuckets;

    if (allBlocked) {
      return {
        name: "Public Access Block",
        passed: true,
        message:
          "All public access is blocked (BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls, RestrictPublicBuckets).",
      };
    } else {
      return {
        name: "Public Access Block",
        passed: false,
        message: "Public access is not fully blocked.",
        warning:
          "It is strongly recommended to block all public access to prevent unauthorized access.",
      };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("Access Denied")) {
      return {
        name: "Public Access Block",
        passed: true,
        message: "Cannot verify public access block (Access Denied).",
        warning:
          "Please manually verify that all public access is blocked in AWS Console.",
      };
    }

    return {
      name: "Public Access Block",
      passed: false,
      message: `Failed to check public access block: ${errorMessage}`,
    };
  }
}

/**
 * Test 5: Validate CORS configuration
 */
async function validateCorsConfiguration(): Promise<ValidationResult> {
  try {
    const s3Client = new S3Client({
      region: process.env.AWS_S3_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
      },
    });

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const response = await s3Client.send(
      new GetBucketCorsCommand({
        Bucket: bucketName,
      }),
    );

    const hasCorsRules = response.CORSRules && response.CORSRules.length > 0;

    if (hasCorsRules) {
      const rules = response.CORSRules!;
      const allowedOrigins = rules.flatMap((rule) => rule.AllowedOrigins || []);
      const allowedMethods = rules.flatMap((rule) => rule.AllowedMethods || []);

      return {
        name: "CORS Configuration",
        passed: true,
        message: `CORS is configured with ${rules.length} rule(s). Allowed origins: ${allowedOrigins.join(", ")}. Allowed methods: ${allowedMethods.join(", ")}.`,
        warning: allowedOrigins.includes("*")
          ? "CORS allows all origins (*). Consider restricting to specific application domains."
          : undefined,
      };
    } else {
      return {
        name: "CORS Configuration",
        passed: false,
        message: "No CORS rules configured.",
        warning:
          "CORS must be configured to allow PUT and GET from your application domains.",
      };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";

    if (errorMessage.includes("NoSuchCORSConfiguration")) {
      return {
        name: "CORS Configuration",
        passed: false,
        message: "No CORS configuration found.",
        warning:
          "CORS must be configured to allow PUT and GET from your application domains.",
      };
    }

    if (errorMessage.includes("Access Denied")) {
      return {
        name: "CORS Configuration",
        passed: true,
        message: "Cannot verify CORS (Access Denied).",
        warning:
          "Please manually verify that CORS is configured in AWS Console.",
      };
    }

    return {
      name: "CORS Configuration",
      passed: false,
      message: `Failed to check CORS configuration: ${errorMessage}`,
    };
  }
}

/**
 * Test 6: Validate presigned URL generation (upload)
 */
async function validatePresignedUploadUrl(): Promise<ValidationResult> {
  try {
    const s3Client = new S3Client({
      region: process.env.AWS_S3_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
      },
    });

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const testKey = `test-validation-${Date.now()}.txt`;

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: testKey,
      ContentType: "text/plain",
    });

    const uploadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600, // 1 hour
    });

    // Verify URL contains required components
    const url = new URL(uploadUrl);
    const hasSignature = url.searchParams.has("X-Amz-Signature");
    const hasExpires = url.searchParams.has("X-Amz-Expires");

    if (hasSignature && hasExpires) {
      const expiresIn = url.searchParams.get("X-Amz-Expires");
      return {
        name: "Presigned Upload URL",
        passed: true,
        message: `Presigned upload URL generated successfully. Expiration: ${expiresIn} seconds (1 hour).`,
      };
    } else {
      return {
        name: "Presigned Upload URL",
        passed: false,
        message: "Presigned URL is missing required signature or expiration.",
      };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      name: "Presigned Upload URL",
      passed: false,
      message: `Failed to generate presigned upload URL: ${errorMessage}`,
    };
  }
}

/**
 * Test 7: Validate presigned URL generation (download)
 */
async function validatePresignedDownloadUrl(): Promise<ValidationResult> {
  try {
    const s3Client = new S3Client({
      region: process.env.AWS_S3_REGION!,
      credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
      },
    });

    const bucketName = process.env.AWS_S3_BUCKET_NAME!;
    const testKey = `test-validation-${Date.now()}.txt`;

    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: testKey,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, {
      expiresIn: 3600, // 1 hour
    });

    // Verify URL contains required components
    const url = new URL(downloadUrl);
    const hasSignature = url.searchParams.has("X-Amz-Signature");
    const hasExpires = url.searchParams.has("X-Amz-Expires");

    if (hasSignature && hasExpires) {
      const expiresIn = url.searchParams.get("X-Amz-Expires");
      return {
        name: "Presigned Download URL",
        passed: true,
        message: `Presigned download URL generated successfully. Expiration: ${expiresIn} seconds (1 hour).`,
      };
    } else {
      return {
        name: "Presigned Download URL",
        passed: false,
        message: "Presigned URL is missing required signature or expiration.",
      };
    }
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    return {
      name: "Presigned Download URL",
      passed: false,
      message: `Failed to generate presigned download URL: ${errorMessage}`,
    };
  }
}

/**
 * Test 8: Validate IAM permissions
 */
function validateIamPermissions(): ValidationResult {
  // This is a documentation check, not a runtime test
  return {
    name: "IAM Permissions (Manual Check)",
    passed: true,
    message:
      "Please manually verify IAM permissions follow least privilege principle:",
    warning:
      'Attachments require s3:PutObject, s3:GetObject, and s3:DeleteObject on "arn:aws:s3:::YOUR_BUCKET/*". MicroVM workspace buckets additionally require bucket-level s3:ListBucket constrained by s3:prefix to "users/*/microvm-workspace/v1/*" and must be never-versioned (GetBucketVersioning returns no status); reject Enabled or Suspended buckets. Before decommissioning a previously versioned bucket, list and delete every object version and delete marker with version-aware admin tooling. No wildcard permissions.',
  };
}

/**
 * Test 9: Reject workspace buckets that are or were versioned.
 *
 * This is intentionally an operator-time check. The runtime identity remains
 * limited to object access plus prefix-scoped ListBucket and does not need
 * bucket-configuration permissions on every user deletion.
 */
export async function validateWorkspaceBucketVersioning(
  readVersioning?: ReadWorkspaceBucketVersioning,
): Promise<ValidationResult> {
  const configured = Object.entries(WORKSPACE_BUCKET_ENV_BY_REGION).filter(
    ([, envName]) => Boolean(process.env[envName]),
  );
  const workspaceProviderSelected =
    process.env.CLOUD_SANDBOX_PROVIDER === "aws-lambda-microvm";

  if (configured.length === 0 && !workspaceProviderSelected) {
    return {
      name: "MicroVM Workspace Bucket Versioning",
      passed: true,
      message: "MicroVM workspace buckets are not configured; check skipped.",
      warning:
        "Run this validation with all workspace bucket environment variables before enabling the AWS Lambda MicroVM provider.",
    };
  }

  const missing = Object.values(WORKSPACE_BUCKET_ENV_BY_REGION).filter(
    (envName) => !process.env[envName],
  );
  if (missing.length > 0) {
    return {
      name: "MicroVM Workspace Bucket Versioning",
      passed: false,
      message: `Missing workspace bucket environment variables: ${missing.join(", ")}`,
    };
  }

  const getVersioning =
    readVersioning ??
    (async (region: WorkspaceRegion, bucketName: string) => {
      const client = new S3Client({
        region,
        credentials: {
          accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
          secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
        },
      });
      const response = await client.send(
        new GetBucketVersioningCommand({ Bucket: bucketName }),
      );
      return response.Status;
    });

  const invalidRegions: string[] = [];
  try {
    for (const [region, envName] of Object.entries(
      WORKSPACE_BUCKET_ENV_BY_REGION,
    ) as Array<[WorkspaceRegion, string]>) {
      const status = await getVersioning(region, process.env[envName]!);
      if (status !== undefined) invalidRegions.push(`${region} (${status})`);
    }
  } catch (error) {
    return {
      name: "MicroVM Workspace Bucket Versioning",
      passed: false,
      message:
        "Failed to verify that every MicroVM workspace bucket is never-versioned: " +
        (error instanceof Error ? error.message : "Unknown error"),
    };
  }

  if (invalidRegions.length > 0) {
    return {
      name: "MicroVM Workspace Bucket Versioning",
      passed: false,
      message: `Workspace buckets must be never-versioned; rejected regions: ${invalidRegions.join(", ")}`,
      warning:
        "Use version-aware administrative cleanup to delete every historical object version and delete marker before decommissioning a previously versioned bucket.",
    };
  }

  return {
    name: "MicroVM Workspace Bucket Versioning",
    passed: true,
    message: "All configured MicroVM workspace buckets are never-versioned.",
  };
}

/**
 * Main validation function
 */
async function main() {
  console.log("=".repeat(60));
  console.log("S3 Security Validation Script");
  console.log("=".repeat(60));
  console.log();

  // Test 1: Environment variables
  const envResult = validateEnvironmentVariables();
  results.push(envResult);
  logResult(envResult);

  // Only continue if environment variables are valid
  if (!envResult.passed) {
    console.log(
      "❌ Validation failed: Missing required environment variables.",
    );
    console.log(
      "Please configure AWS S3 credentials in .env.local and try again.",
    );
    process.exit(1);
  }

  // Test 2: S3 Client & Credentials
  const s3ClientResult = await validateS3Client();
  results.push(s3ClientResult);
  logResult(s3ClientResult);

  if (!s3ClientResult.passed) {
    console.log("❌ Validation failed: Cannot access S3 bucket.");
    console.log("Please check AWS credentials and bucket configuration.");
    process.exit(1);
  }

  // Test 3: Bucket Encryption
  const encryptionResult = await validateBucketEncryption();
  results.push(encryptionResult);
  logResult(encryptionResult);

  // Test 4: Public Access Block
  const publicAccessResult = await validatePublicAccessBlock();
  results.push(publicAccessResult);
  logResult(publicAccessResult);

  // Test 5: CORS Configuration
  const corsResult = await validateCorsConfiguration();
  results.push(corsResult);
  logResult(corsResult);

  // Test 6: Presigned Upload URL
  const uploadUrlResult = await validatePresignedUploadUrl();
  results.push(uploadUrlResult);
  logResult(uploadUrlResult);

  // Test 7: Presigned Download URL
  const downloadUrlResult = await validatePresignedDownloadUrl();
  results.push(downloadUrlResult);
  logResult(downloadUrlResult);

  // Test 8: IAM Permissions
  const iamResult = validateIamPermissions();
  results.push(iamResult);
  logResult(iamResult);

  // Test 9: Workspace buckets must never have had versioning enabled
  const workspaceVersioningResult = await validateWorkspaceBucketVersioning();
  results.push(workspaceVersioningResult);
  logResult(workspaceVersioningResult);

  // Summary
  console.log("=".repeat(60));
  console.log("Validation Summary");
  console.log("=".repeat(60));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => r.passed === false).length;
  const warnings = results.filter((r) => r.warning).length;

  console.log(`Total Tests: ${results.length}`);
  console.log(`Passed: ${passed} ✅`);
  console.log(`Failed: ${failed} ❌`);
  console.log(`Warnings: ${warnings} ⚠️`);
  console.log();

  if (failed > 0) {
    console.log(
      "❌ Validation failed. Please address the issues above and run again.",
    );
    process.exit(1);
  } else if (warnings > 0) {
    console.log(
      "⚠️  Validation passed with warnings. Please review the warnings above.",
    );
    process.exit(0);
  } else {
    console.log("✅ All validation checks passed!");
    console.log("Your S3 configuration is properly set up and secure.");
    process.exit(0);
  }
}

// Run validation only when invoked as a script; tests import the focused checks.
if (require.main === module) {
  main().catch((error) => {
    console.error("Fatal error during validation:", error);
    process.exit(1);
  });
}
