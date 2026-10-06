# Terraform state backend

PSOP production Terraform state must not be committed to Git.

The intended backend is Amazon S3 with:

- Block Public Access enabled;
- encryption at rest;
- bucket versioning;
- Terraform S3 lockfile support.

The backend bucket is bootstrapped independently because Terraform cannot
store its own state in an S3 bucket before that bucket exists.

Do not place AWS credentials inside Terraform backend configuration files.
