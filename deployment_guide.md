# StaffEase VPS Deployment Guide

Complete step-by-step instructions to deploy StaffEase on **`staffease.macrotechsoftwares.com`** using an **Ubuntu/Debian VPS** and **Hostinger DNS**.

---

## Overview Architecture

- **Domain**: `macrotechsoftwares.com` (Hostinger)
- **Subdomain**: `staffease.macrotechsoftwares.com`
- **WebServer**: Nginx (handling Single Page App routing & SSL)
- **SSL Certificate**: Certbot / Let's Encrypt (Free, auto-renewing HTTPS)
- **Backend / Database**: Supabase (`https://ufujcwfakwdtyhbmolyr.supabase.co`)

---

## Step 1: Point Subdomain DNS on Hostinger

1. Log into your **Hostinger Dashboard**.
2. Go to **Domains** -> Select **`macrotechsoftwares.com`** -> **DNS / Name Servers** (DNS Zone Editor).
3. Add a new **A Record**:
   - **Type**: `A`
   - **Name**: `staffease`
   - **Points to**: `YOUR_VPS_PUBLIC_IP` *(e.g., 123.45.67.89)*
   - **TTL**: `3600` (Default)
4. Save the record. *(DNS propagation takes 2–15 minutes)*.

---

## Step 2: Prepare VPS Server

Log into your VPS server via SSH:

```bash
ssh root@YOUR_VPS_PUBLIC_IP
```

Install **Nginx**, **Git**, and **Certbot**:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Nginx and Git
sudo apt install -y nginx git curl

# Install Certbot for free SSL (HTTPS)
sudo apt install -y certbot python3-certbot-nginx
```

---

## Step 3: Build & Upload StaffEase Web Files

### Option A: Build Locally & Upload via SCP (Recommended)

1. On your local machine in the `staffease` project directory, run:
   ```bash
   npm run build
   ```
   *(This outputs compiled production files inside `dist/`)*.

2. Create the target directory on your VPS:
   ```bash
   ssh root@YOUR_VPS_PUBLIC_IP "mkdir -p /var/www/staffease"
   ```

3. Upload the built `dist/` directory contents to your VPS:
   ```bash
   scp -r dist/* root@YOUR_VPS_PUBLIC_IP:/var/www/staffease/
   ```

---

## Step 4: Configure Nginx Server Block

1. Create a new Nginx configuration file for `staffease`:

```bash
sudo nano /etc/nginx/sites-available/staffease
```

2. Paste the following configuration:

```nginx
server {
    listen 80;
    server_name staffease.macrotechsoftwares.com;

    root /var/www/staffease;
    index index.html;

    # Handle React / Vite SPA Client-side Routing
    location / {
        try_files $uri $uri/ /index.html;
    }

    # Cache static assets for fast performance
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff|woff2)$ {
        expires 30d;
        add_header Cache-Control "public, no-transform";
    }

    # Security Headers
    add_header X-Frame-Options "SAMEORIGIN";
    add_header X-XSS-Protection "1; mode=block";
    add_header X-Content-Type-Options "nosniff";
}
```

3. Enable the configuration and test Nginx:

```bash
# Create symbolic link to enable site
sudo ln -s /etc/nginx/sites-available/staffease /etc/nginx/sites-enabled/

# Test configuration for syntax errors
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

---

## Step 5: Install Free SSL Certificate (HTTPS)

Run **Certbot** to generate and automatically install an SSL certificate for your subdomain:

```bash
sudo certbot --nginx -d staffease.macrotechsoftwares.com
```

- Enter your email when prompted.
- Select automatic HTTP-to-HTTPS redirect if asked.

Certbot will update your Nginx configuration automatically with SSL certificates and set up automatic renewal!

---

## Step 6: Verify Deployment

1. Open your browser and visit:  
   **`https://staffease.macrotechsoftwares.com`**

2. Test features:
   - Login with Admin / Super Admin account.
   - Verify attendance logs, calendar view, employee management, and payroll reports.

---

## Step 7: Quick Redeployment Script (For Future Updates)

To update your website whenever you make new code changes, create a file named `deploy.sh` on your local computer:

```bash
#!/bin/bash
echo "🚀 Building StaffEase production bundle..."
npm run build

echo "📤 Uploading build to VPS server..."
scp -r dist/* root@YOUR_VPS_PUBLIC_IP:/var/www/staffease/

echo "✅ StaffEase updated successfully at https://staffease.macrotechsoftwares.com"
```

Make it executable:
```bash
chmod +x deploy.sh
```

Now you can update your live site anytime by simply running `./deploy.sh`!
