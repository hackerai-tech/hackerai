#!/usr/bin/env ts-node
/**
 * S3 Security Validation Script
 *
 * Validates that S3 bucket is properly hardened and configured for production use.
 *
 * Checks:
 * - CORS configuration
 * - Bucket policies and IAM permissions
 * - Encryption settings
 * - Public access blocking
 * - Lifecycle policies
 * - Presigned URL functionality
 *
 * Usage:
 *   ts-node scripts/validate-s3-security.ts
 *   # or with environment variables:
 *   AWS_S3_BUCKET_NAME=my-bucket ts-node scripts/validate-s3-security.ts
 */

import {
  S3Client,
  GetBucketCorsCommand,
  GetBucketPolicyCommand,
  GetBucketEncryptionCommand,
  GetPublicAccessBlockCommand,
  GetBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

// =============================================================================
// CONFIGURATION
// =============================================================================

interface ValidationResult {
  passed: boolean;
  message: string;
  severity: "critical" | "warning" | "info";
  details?: string;
}

interface ValidationReport {
  timestamp: string;
  bucketName: string;
  region: string;
  results: ValidationResult[];
  summary: {
    critical: number;
    warnings: number;
    passed: number;
    total: number;
  };
}

const REQUIRED_ENV_VARS = [
  "AWS_S3_ACCESS_KEY_ID",
  "AWS_S3_SECRET_ACCESS_KEY",
  "AWS_S3_REGION",
  "AWS_S3_BUCKET_NAME",
];

// =============================================================================
// UTILITIES
// =============================================================================

const colors = {
  reset: "\x1b[0m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
};

function log(message: string, color?: keyof typeof colors) {
  const colorCode = color ? colors[color] : "";
  console.log(`${colorCode}${message}${colors.reset}`);
}

function logResult(result: ValidationResult) {
  const icon = result.passed ? "✓" : "✗";
  const color = result.passed
    ? "green"
    : result.severity === "critical"
      ? "red"
      : "yellow";

  log(`${icon} ${result.message}`, color);
  if (result.details) {
    // Handle multiline details with proper indentation
    const lines = result.details.split("\n");
    for (const line of lines) {
      if (line.trim()) {
        log(`  ${line}`, "cyan");
      } else {
        log(""); // Empty line
      }
    }
  }
}

// =============================================================================
// VALIDATION CHECKS
// =============================================================================

/**
 * Check environment variables
 */
function validateEnvironment(): ValidationResult[] {
  const results: ValidationResult[] = [];

  for (const varName of REQUIRED_ENV_VARS) {
    if (!process.env[varName]) {
      results.push({
        passed: false,
        severity: "critical",
        message: `Missing environment variable: ${varName}`,
      });
    } else {
      results.push({
        passed: true,
        severity: "info",
        message: `Environment variable ${varName} is set`,
      });
    }
  }

  return results;
}

/**
 * Check CORS configuration
 */
async function validateCORS(
  s3Client: S3Client,
  bucketName: string,
): Promise<ValidationResult> {
  try {
    const response = await s3Client.send(
      new GetBucketCorsCommand({ Bucket: bucketName }),
    );

    if (!response.CORSRules || response.CORSRules.length === 0) {
      return {
        passed: false,
        severity: "critical",
        message: "CORS: No CORS rules configured",
        details: "Browser uploads will fail without CORS configuration",
      };
    }

    const rules = response.CORSRules;
    const hasUploadRule = rules.some(
      (rule) =>
        rule.AllowedMethods?.includes("PUT") ||
        rule.AllowedMethods?.includes("POST"),
    );
    const hasDownloadRule = rules.some((rule) =>
      rule.AllowedMethods?.includes("GET"),
    );

    if (!hasUploadRule) {
      return {
        passed: false,
        severity: "critical",
        message: "CORS: Missing PUT/POST methods for uploads",
        details: `Current methods: ${rules.map((r) => r.AllowedMethods?.join(", ")).join(" | ")}`,
      };
    }

    if (!hasDownloadRule) {
      return {
        passed: false,
        severity: "warning",
        message: "CORS: Missing GET method for downloads",
        details: "Direct browser downloads may fail",
      };
    }

    // Extract all allowed origins
    const allOrigins = rules.flatMap((r) => r.AllowedOrigins || []);
    const uniqueOrigins = [...new Set(allOrigins)];

    return {
      passed: true,
      severity: "info",
      message: `CORS: Properly configured with ${rules.length} rule(s)`,
      details: [
        `Methods: ${rules.map((r) => r.AllowedMethods?.join(", ")).join(" | ")}`,
        "",
        `Allowed Origins (${uniqueOrigins.length}):`,
        ...uniqueOrigins.map((origin) => `  • ${origin}`),
      ].join("\n"),
    };
  } catch (error: any) {
    if (error.name === "NoSuchCORSConfiguration") {
      return {
        passed: false,
        severity: "critical",
        message: "CORS: Not configured",
        details: "Run: aws s3api put-bucket-cors --bucket BUCKET --cors-configuration file://cors.json",
      };
    }
    return {
      passed: false,
      severity: "critical",
      message: `CORS: Failed to check - ${error.message}`,
    };
  }
}

/**
 * Check bucket policy
 */
async function validateBucketPolicy(
  s3Client: S3Client,
  bucketName: string,
): Promise<ValidationResult> {
  try {
    const response = await s3Client.send(
      new GetBucketPolicyCommand({ Bucket: bucketName }),
    );

    if (!response.Policy) {
      return {
        passed: false,
        severity: "warning",
        message: "Bucket Policy: No policy configured",
        details: "Consider adding a policy to restrict access",
      };
    }

    const policy = JSON.parse(response.Policy);
    const hasPublicAccess = policy.Statement?.some(
      (stmt: any) =>
        stmt.Principal === "*" || stmt.Principal?.AWS === "*",
    );

    if (hasPublicAccess) {
      return {
        passed: false,
        severity: "critical",
        message: "Bucket Policy: Contains public access statements",
        details: "Bucket allows public access - this is a security risk!",
      };
    }

    return {
      passed: true,
      severity: "info",
      message: "Bucket Policy: Configured without public access",
      details: `${policy.Statement?.length || 0} statement(s)`,
    };
  } catch (error: any) {
    if (error.name === "NoSuchBucketPolicy") {
      return {
        passed: true,
        severity: "info",
        message: "Bucket Policy: Not set (using IAM permissions only)",
        details: "Ensure IAM user has proper permissions",
      };
    }
    return {
      passed: false,
      severity: "warning",
      message: `Bucket Policy: Failed to check - ${error.message}`,
    };
  }
}

/**
 * Check encryption
 */
async function validateEncryption(
  s3Client: S3Client,
  bucketName: string,
): Promise<ValidationResult> {
  try {
    const response = await s3Client.send(
      new GetBucketEncryptionCommand({ Bucket: bucketName }),
    );

    if (!response.ServerSideEncryptionConfiguration?.Rules) {
      return {
        passed: false,
        severity: "critical",
        message: "Encryption: Not enabled",
        details: "Enable default encryption for data-at-rest security",
      };
    }

    const rules = response.ServerSideEncryptionConfiguration.Rules;
    const encryptionType =
      rules[0]?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm;

    if (encryptionType === "AES256") {
      return {
        passed: true,
        severity: "info",
        message: "Encryption: Enabled with AES256 (S3-managed keys)",
      };
    } else if (encryptionType === "aws:kms") {
      return {
        passed: true,
        severity: "info",
        message: "Encryption: Enabled with KMS (customer-managed keys)",
        details: "Highest security level",
      };
    }

    return {
      passed: false,
      severity: "critical",
      message: `Encryption: Unknown type - ${encryptionType}`,
    };
  } catch (error: any) {
    if (error.name === "ServerSideEncryptionConfigurationNotFoundError") {
      return {
        passed: false,
        severity: "critical",
        message: "Encryption: Not configured",
        details: "Run: aws s3api put-bucket-encryption --bucket BUCKET --server-side-encryption-configuration '{...}'",
      };
    }
    return {
      passed: false,
      severity: "warning",
      message: `Encryption: Failed to check - ${error.message}`,
    };
  }
}

/**
 * Check public access block
 */
async function validatePublicAccessBlock(
  s3Client: S3Client,
  bucketName: string,
): Promise<ValidationResult> {
  try {
    const response = await s3Client.send(
      new GetPublicAccessBlockCommand({ Bucket: bucketName }),
    );

    const config = response.PublicAccessBlockConfiguration;

    if (
      !config?.BlockPublicAcls ||
      !config?.BlockPublicPolicy ||
      !config?.IgnorePublicAcls ||
      !config?.RestrictPublicBuckets
    ) {
      return {
        passed: false,
        severity: "critical",
        message: "Public Access Block: Not fully enabled",
        details: `BlockPublicAcls: ${config?.BlockPublicAcls}, BlockPublicPolicy: ${config?.BlockPublicPolicy}, IgnorePublicAcls: ${config?.IgnorePublicAcls}, RestrictPublicBuckets: ${config?.RestrictPublicBuckets}`,
      };
    }

    return {
      passed: true,
      severity: "info",
      message: "Public Access Block: Fully enabled",
      details: "All public access is blocked - excellent security",
    };
  } catch (error: any) {
    if (error.name === "NoSuchPublicAccessBlockConfiguration") {
      return {
        passed: false,
        severity: "critical",
        message: "Public Access Block: Not configured",
        details: "Run: aws s3api put-public-access-block --bucket BUCKET --public-access-block-configuration '{...}'",
      };
    }
    return {
      passed: false,
      severity: "critical",
      message: `Public Access Block: Failed to check - ${error.message}`,
    };
  }
}

/**
 * Check lifecycle policies
 */
async function validateLifecycle(
  s3Client: S3Client,
  bucketName: string,
): Promise<ValidationResult> {
  try {
    const response = await s3Client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucketName }),
    );

    if (!response.Rules || response.Rules.length === 0) {
      return {
        passed: false,
        severity: "warning",
        message: "Lifecycle Policies: Not configured (Optional)",
        details: [
          "Lifecycle policies automatically manage file lifecycle to reduce storage costs.",
          "",
          "Common use cases:",
          "• Transition old files to cheaper storage (S3 Glacier) after 30/90 days",
          "• Automatically delete files after a retention period (e.g., 1 year)",
          "• Clean up incomplete multipart uploads",
          "",
          "Cost savings example: Moving 1TB to Glacier saves ~$18/month",
          "",
          "This is OPTIONAL - only needed if you want automatic cost optimization.",
          "Without lifecycle policies, files stay in S3 Standard storage indefinitely.",
        ].join("\n"),
      };
    }

    return {
      passed: true,
      severity: "info",
      message: `Lifecycle: ${response.Rules.length} rule(s) configured`,
      details: response.Rules.map((r) => `${r.ID}: ${r.Status}`).join(", "),
    };
  } catch (error: any) {
    if (error.name === "NoSuchLifecycleConfiguration") {
      return {
        passed: false,
        severity: "warning",
        message: "Lifecycle Policies: Not configured (Optional)",
        details: [
          "Lifecycle policies automatically manage file lifecycle to reduce storage costs.",
          "",
          "Common use cases:",
          "• Transition old files to cheaper storage (S3 Glacier) after 30/90 days",
          "• Automatically delete files after a retention period (e.g., 1 year)",
          "• Clean up incomplete multipart uploads",
          "",
          "Cost savings example: Moving 1TB to Glacier saves ~$18/month",
          "",
          "This is OPTIONAL - only needed if you want automatic cost optimization.",
          "Without lifecycle policies, files stay in S3 Standard storage indefinitely.",
        ].join("\n"),
      };
    }
    return {
      passed: false,
      severity: "info",
      message: `Lifecycle: Failed to check - ${error.message}`,
    };
  }
}

/**
 * Test presigned URL generation and upload
 */
async function testPresignedURLs(
  s3Client: S3Client,
  bucketName: string,
): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  const testKey = `__security-test__/${Date.now()}.txt`;
  const testContent = "Security validation test";

  try {
    // Test upload presigned URL
    const putCommand = new PutObjectCommand({
      Bucket: bucketName,
      Key: testKey,
      ContentType: "text/plain",
    });

    const uploadUrl = await getSignedUrl(s3Client, putCommand, {
      expiresIn: 3600,
    });

    results.push({
      passed: true,
      severity: "info",
      message: "Presigned URL: Upload URL generation successful",
      details: "✓ Can generate presigned PUT URLs for file uploads",
    });

    // Test actual upload
    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      body: testContent,
      headers: { "Content-Type": "text/plain" },
    });

    if (!uploadResponse.ok) {
      results.push({
        passed: false,
        severity: "critical",
        message: `Presigned URL: Upload failed - HTTP ${uploadResponse.status}`,
        details: [
          await uploadResponse.text(),
          "",
          "This likely means:",
          "• CORS is not configured correctly",
          "• IAM permissions don't allow PutObject",
          "• Bucket policy is blocking uploads",
        ].join("\n"),
      });
      return results;
    }

    results.push({
      passed: true,
      severity: "info",
      message: "Presigned URL: Upload test successful",
      details: "✓ Successfully uploaded test file via presigned URL",
    });

    // Test download presigned URL
    const getCommand = new GetObjectCommand({
      Bucket: bucketName,
      Key: testKey,
    });

    const downloadUrl = await getSignedUrl(s3Client, getCommand, {
      expiresIn: 3600,
    });

    results.push({
      passed: true,
      severity: "info",
      message: "Presigned URL: Download URL generation successful",
      details: "✓ Can generate presigned GET URLs for file downloads",
    });

    // Test actual download
    const downloadResponse = await fetch(downloadUrl);

    if (!downloadResponse.ok) {
      results.push({
        passed: false,
        severity: "critical",
        message: `Presigned URL: Download failed - HTTP ${downloadResponse.status}`,
        details: [
          await downloadResponse.text(),
          "",
          "This likely means:",
          "• IAM permissions don't allow GetObject",
          "• Bucket policy is blocking downloads",
        ].join("\n"),
      });
      return results;
    }

    const downloadedContent = await downloadResponse.text();
    if (downloadedContent === testContent) {
      results.push({
        passed: true,
        severity: "info",
        message: "Presigned URL: Download test successful",
        details: "✓ Successfully downloaded and verified file content",
      });
    } else {
      results.push({
        passed: false,
        severity: "critical",
        message: "Presigned URL: Content mismatch",
        details: `Expected: "${testContent}", Got: "${downloadedContent}"`,
      });
    }

    // Cleanup test file
    await s3Client.send(
      new DeleteObjectCommand({ Bucket: bucketName, Key: testKey }),
    );

    results.push({
      passed: true,
      severity: "info",
      message: "Presigned URL: Cleanup successful",
      details: "✓ Test file deleted successfully",
    });
  } catch (error: any) {
    results.push({
      passed: false,
      severity: "critical",
      message: `Presigned URL: Test failed - ${error.message}`,
      details: [
        error.stack,
        "",
        "Common causes:",
        "• Network connectivity issues",
        "• Invalid AWS credentials",
        "• Bucket doesn't exist",
        "• Region mismatch",
      ].join("\n"),
    });
  }

  return results;
}

// =============================================================================
// MAIN VALIDATION FLOW
// =============================================================================

async function runValidation(): Promise<ValidationReport> {
  log("\n🔐 S3 Security Validation\n", "cyan");

  const results: ValidationResult[] = [];

  // Check environment
  log("📋 Checking environment variables...", "blue");
  const envResults = validateEnvironment();
  results.push(...envResults);

  const hasRequiredEnv = envResults.every((r) => r.passed);
  if (!hasRequiredEnv) {
    log("\n❌ Missing required environment variables. Exiting.\n", "red");
    return generateReport(results);
  }

  const bucketName = process.env.AWS_S3_BUCKET_NAME!;
  const region = process.env.AWS_S3_REGION!;

  const s3Client = new S3Client({
    region,
    credentials: {
      accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
      secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
    },
  });

  // Run validation checks
  log("\n🔍 Validating S3 configuration...\n", "blue");

  const checks = [
    { name: "CORS", fn: () => validateCORS(s3Client, bucketName) },
    { name: "Bucket Policy", fn: () => validateBucketPolicy(s3Client, bucketName) },
    { name: "Encryption", fn: () => validateEncryption(s3Client, bucketName) },
    {
      name: "Public Access Block",
      fn: () => validatePublicAccessBlock(s3Client, bucketName),
    },
    { name: "Lifecycle", fn: () => validateLifecycle(s3Client, bucketName) },
  ];

  for (const check of checks) {
    log(`Checking ${check.name}...`);
    try {
      const result = await check.fn();
      if (Array.isArray(result)) {
        results.push(...result);
        result.forEach(logResult);
      } else {
        results.push(result);
        logResult(result);
      }
    } catch (error: any) {
      const errorResult: ValidationResult = {
        passed: false,
        severity: "critical",
        message: `${check.name}: Unexpected error - ${error.message}`,
      };
      results.push(errorResult);
      logResult(errorResult);
    }
    log(""); // Empty line
  }

  // Test presigned URLs
  log("🧪 Testing presigned URL functionality...\n", "blue");
  const presignedResults = await testPresignedURLs(s3Client, bucketName);
  results.push(...presignedResults);
  presignedResults.forEach(logResult);

  return generateReport(results);
}

function generateReport(results: ValidationResult[]): ValidationReport {
  const summary = {
    critical: results.filter((r) => !r.passed && r.severity === "critical")
      .length,
    warnings: results.filter((r) => !r.passed && r.severity === "warning")
      .length,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
  };

  return {
    timestamp: new Date().toISOString(),
    bucketName: process.env.AWS_S3_BUCKET_NAME || "unknown",
    region: process.env.AWS_S3_REGION || "unknown",
    results,
    summary,
  };
}

function printSummary(report: ValidationReport) {
  log("\n" + "=".repeat(80), "cyan");
  log("📊 VALIDATION SUMMARY", "cyan");
  log("=".repeat(80), "cyan");

  log(`\nBucket: ${report.bucketName}`);
  log(`Region: ${report.region}`);
  log(`Timestamp: ${report.timestamp}\n`);

  log(`Total Checks: ${report.summary.total}`);
  log(`✓ Passed: ${report.summary.passed}`, "green");

  if (report.summary.warnings > 0) {
    log(`⚠ Warnings: ${report.summary.warnings}`, "yellow");
  }

  if (report.summary.critical > 0) {
    log(`✗ Critical Issues: ${report.summary.critical}`, "red");
  }

  log("");

  if (report.summary.critical === 0 && report.summary.warnings === 0) {
    log("🎉 All checks passed! Your S3 bucket is properly hardened.", "green");
  } else if (report.summary.critical === 0) {
    log(
      "⚠️  Bucket is secure but has some warnings. Review recommendations above.",
      "yellow",
    );
  } else {
    log(
      "❌ Critical security issues found! Fix these before deploying to production.",
      "red",
    );
  }

  log("\n" + "=".repeat(80) + "\n", "cyan");
}

// =============================================================================
// EXECUTION
// =============================================================================

async function main() {
  try {
    const report = await runValidation();
    printSummary(report);

    // Exit with error code if critical issues found
    if (report.summary.critical > 0) {
      process.exit(1);
    }
  } catch (error: any) {
    log(`\n❌ Validation failed: ${error.message}\n`, "red");
    console.error(error);
    process.exit(1);
  }
}

main();
