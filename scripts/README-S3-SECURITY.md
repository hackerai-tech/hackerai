# S3 Security Validation

This directory contains a tool for validating your S3 bucket security for production use.

## 📋 Files

- **`validate-s3-security.ts`** - Comprehensive security validation script

## 🚀 Quick Start

### 1. Install Dependencies

```bash
pnpm install
```

This will install the required `@aws-sdk/client-cloudwatch` package.

### 2. Configure Environment

Ensure your `.env.local` has the following variables:

```env
AWS_S3_ACCESS_KEY_ID=your_access_key
AWS_S3_SECRET_ACCESS_KEY=your_secret_key
AWS_S3_REGION=us-east-2
AWS_S3_BUCKET_NAME=your_bucket_name
```

### 3. Run Security Validation

```bash
pnpm s3:validate
```

This will check:
- ✅ CORS configuration (with allowed origins/hostnames)
- ✅ Bucket policies
- ✅ Encryption settings
- ✅ Public access blocking
- ✅ Lifecycle policies (optional cost optimization)
- ✅ Presigned URL functionality (actual upload/download test)

## 📊 Validation Checks

### Critical Checks ❌

These **must** pass for production:

1. **CORS Configuration**
   - Must allow PUT/POST for uploads
   - Must allow GET for downloads
   - Should include your domain origins

2. **Encryption**
   - Must have default encryption enabled (AES256 or KMS)
   - Protects data at rest

3. **Public Access Block**
   - All 4 settings must be enabled:
     - BlockPublicAcls
     - BlockPublicPolicy
     - IgnorePublicAcls
     - RestrictPublicBuckets

4. **Bucket Policy**
   - Must NOT contain public access statements
   - Should restrict to authorized IAM users/roles

5. **Presigned URLs**
   - Upload and download functionality must work
   - Tests actual file operations

### Warning Checks ⚠️

These are **optional** recommendations for cost optimization:

1. **Lifecycle Policies**
   - Automatically transition old files to cheaper storage (S3 Glacier)
   - Automatically delete files after retention period
   - Clean up incomplete multipart uploads
   - **Cost savings example**: Moving 1TB to Glacier saves ~$18/month
   - **Without lifecycle policies**: Files stay in S3 Standard storage indefinitely

## 🔒 Security Best Practices

### IAM Permissions

Your IAM user/role needs these permissions:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:GetObject",
        "s3:DeleteObject",
        "s3:GetBucketCors",
        "s3:GetBucketPolicy",
        "s3:GetBucketEncryption",
        "s3:GetBucketPublicAccessBlock",
        "s3:GetBucketLifecycleConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::your-bucket-name",
        "arn:aws:s3:::your-bucket-name/*"
      ]
    }
  ]
}
```

### Encryption Setup

Enable default encryption with AWS CLI:

```bash
aws s3api put-bucket-encryption \
  --bucket your-bucket-name \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "AES256"
      },
      "BucketKeyEnabled": true
    }]
  }'
```

### Public Access Block Setup

Block all public access with AWS CLI:

```bash
aws s3api put-public-access-block \
  --bucket your-bucket-name \
  --public-access-block-configuration \
    "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

## 🎯 What Gets Validated

The script performs **real, end-to-end tests**:

1. **Reads** your bucket configuration from AWS
2. **Validates** CORS rules and lists all allowed origins/hostnames
3. **Checks** encryption, public access blocks, and policies
4. **Tests** presigned URL generation
5. **Uploads** a real test file to verify CORS and permissions
6. **Downloads** the file to verify retrieval
7. **Cleans up** the test file
8. **Reports** issues with detailed explanations and fix recommendations

## 🧪 Testing Presigned URLs

The validation script automatically tests presigned URL functionality by:

1. Generating a presigned upload URL
2. Uploading a test file
3. Generating a presigned download URL
4. Downloading and verifying the file content
5. Cleaning up the test file

This ensures your IAM permissions and CORS configuration are correct.

## 🐛 Troubleshooting

### "NoSuchCORSConfiguration" Error

**Cause**: CORS not configured

**Fix**: Configure CORS manually via AWS console or CLI

### "Access Denied" Errors

**Cause**: IAM permissions insufficient

**Fix**: Ensure IAM user has all required S3 permissions (see IAM Permissions section)

### Presigned URL Upload Fails

**Causes**:
1. CORS not configured correctly
2. Bucket policy blocks uploads

**Fix**:
1. Verify CORS includes PUT/POST methods via AWS console
2. Check bucket policy doesn't deny PutObject


## 🎯 Pre-Production Checklist

Before deploying to production, ensure:

- [ ] All **critical** validation checks pass (no ❌)
- [ ] CORS configured with correct origins/hostnames
- [ ] Encryption enabled (AES256 or KMS)
- [ ] Public access fully blocked
- [ ] IAM permissions follow least-privilege principle
- [ ] Presigned URL tests pass (upload & download)
- [ ] Test file uploads/downloads from production URL
- [ ] Consider lifecycle policies for cost optimization
- [ ] Document backup/disaster recovery procedures

## 📚 Additional Resources

- [AWS S3 Security Best Practices](https://docs.aws.amazon.com/AmazonS3/latest/userguide/security-best-practices.html)
- [S3 CORS Configuration](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html)
- [Presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [S3 Encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingEncryption.html)

## 🆘 Need Help?

If validation fails with critical issues:

1. Review the detailed error messages and recommendations
2. Check the AWS S3 console for bucket configuration
3. Verify IAM permissions are correctly set
4. Test with AWS CLI to isolate configuration issues
5. Consult AWS documentation for specific error codes

---

**Last Updated**: November 2024
