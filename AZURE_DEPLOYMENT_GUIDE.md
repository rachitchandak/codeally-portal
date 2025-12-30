# Azure Deployment Guide - CodeAlly Portal

This guide provides step-by-step instructions to deploy the CodeAlly Portal web application to Azure App Service using the Azure Portal GUI.

---

## Prerequisites

1. An Azure account with an active subscription
2. The CodeAlly Portal code pushed to a GitHub repository
3. A web browser

---

## Step 1: Create an Azure App Service

### 1.1 Navigate to Azure Portal

1. Go to [https://portal.azure.com](https://portal.azure.com)
2. Sign in with your Azure account

### 1.2 Create a New Web App

1. Click **"+ Create a resource"** in the top-left corner
2. Search for **"Web App"** and click on it
3. Click **"Create"**

### 1.3 Configure Basic Settings

Fill in the following fields:

| Field | Value |
|-------|-------|
| **Subscription** | Select your Azure subscription |
| **Resource Group** | Click "Create new" → Enter `CodeAllyPortal-RG` → Click OK |
| **Name** | Enter a unique name (e.g., `codeally-portal-yourname`) - This becomes your URL |
| **Publish** | Select **Code** |
| **Runtime stack** | Select **Node 20 LTS** |
| **Operating System** | Select **Linux** |
| **Region** | Choose the region closest to your users |

### 1.4 Configure App Service Plan

1. Under **App Service Plan**, click **"Create new"**
2. Enter a name: `CodeAllyPortal-Plan`
3. Click **"Change size"** under Pricing Plan
4. Select a pricing tier:
   - **F1 (Free)** - For testing (1GB storage, limited features)
   - **B1 (Basic)** - For production ($13/month, 10GB storage)
   - **S1 (Standard)** - For larger deployments ($70/month, 50GB storage)

5. Click **"Apply"**

### 1.5 Review and Create

1. Click **"Review + create"**
2. Review all settings
3. Click **"Create"**
4. Wait for deployment to complete (2-3 minutes)
5. Click **"Go to resource"**

---

## Step 2: Configure Environment Variables

### 2.1 Navigate to Configuration

1. In your App Service, click **"Configuration"** in the left sidebar (under Settings)
2. Click the **"Application settings"** tab

### 2.2 Add Environment Variables

Click **"+ New application setting"** for each of these:

| Name | Value |
|------|-------|
| `JWT_SECRET` | `your-secure-random-string-here` (generate a strong 32+ character string) |
| `NODE_ENV` | `production` |

> ⚠️ **Important**: Generate a secure JWT secret. You can use this online tool: https://randomkeygen.com/

### 2.3 Save Changes

1. Click **"Save"** at the top
2. Click **"Continue"** when prompted to restart the app

---

## Step 3: Deploy Your Code

### Option A: Deploy from GitHub (Recommended)

#### 3A.1 Push Code to GitHub

1. Create a new repository on GitHub
2. Push your CodeAlly Portal code:
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```

#### 3A.2 Configure Deployment Center

1. In your App Service, click **"Deployment Center"** in the left sidebar
2. Under **Source**, select **GitHub**
3. Click **"Authorize"** and sign in to GitHub
4. Select:
   - **Organization**: Your GitHub username
   - **Repository**: Your repository name
   - **Branch**: `main`
5. Click **"Save"**

#### 3A.3 Monitor Deployment

1. The deployment will start automatically
2. Click on the deployment row to view logs
3. Wait for status to show **"Success"** (5-10 minutes for first deployment)

### Option B: Deploy via ZIP Upload

#### 3B.1 Prepare ZIP File

1. In your project folder, create a ZIP file containing all files:
   - `server.js`
   - `package.json`
   - `middleware/` folder
   - `models/` folder
   - `routes/` folder
   - `public/` folder

2. **Do NOT include**: `node_modules/`, `.env`, `data/`

#### 3B.2 Upload ZIP

1. In your App Service, click **"Advanced Tools"** → **"Go"**
2. In the Kudu console, go to **Debug console** → **CMD**
3. Navigate to `site/wwwroot`
4. Drag and drop your ZIP file into the browser window
5. The file will extract automatically

---

## Step 4: Verify Deployment

### 4.1 Check Application Status

1. In your App Service, click **"Overview"**
2. Click on the URL (e.g., `https://codeally-portal-yourname.azurewebsites.net`)
3. You should see the sign-in page

### 4.2 Test Login

1. Sign in with the default admin credentials:
   - **Email**: `admin@codeally.com`
   - **Password**: `Admin@123`

2. You should be redirected to the admin dashboard

> ⚠️ **Security Warning**: Change the default admin password after first login by:
> 1. Using the SQLite database directly via Kudu console, or
> 2. Adding a password change feature to the application

---

## Step 5: Configure Persistent Storage (Automatic)

The application uses the `/home/data` directory which is **automatically persistent** in Azure App Service. No additional configuration is required.

### Storage Behavior:

| Path | Persistence | Purpose |
|------|-------------|---------|
| `/home/data/database.sqlite` | ✅ Persistent | User database |
| `/home/data/uploads/` | ✅ Persistent | VSIX files |
| `/tmp/` | ❌ Temporary | Not used |

---

## Step 6: Configure Custom Domain (Optional)

### 6.1 Add Custom Domain

1. In your App Service, click **"Custom domains"**
2. Click **"+ Add custom domain"**
3. Enter your domain name (e.g., `portal.yourdomain.com`)
4. Follow the DNS configuration instructions shown

### 6.2 Add SSL Certificate

1. After adding the domain, click **"Add binding"**
2. Select **"App Service Managed Certificate"** (free)
3. Click **"Create"**

---

## Troubleshooting

### Application Won't Start

1. Go to **"Log stream"** in the left sidebar
2. Check for error messages
3. Common issues:
   - Missing environment variables → Check Configuration
   - Dependency issues → Check that `package.json` is in the root

### Database Errors

1. Go to **"Advanced Tools"** → **"Go"**
2. Navigate to **Debug console** → **Bash**
3. Run: `ls -la /home/data/`
4. Check if `database.sqlite` exists

### Deployment Fails

1. Go to **"Deployment Center"** → Click on the failed deployment
2. View the logs for specific error messages
3. Common fixes:
   - Ensure `package.json` has correct dependencies
   - Check that Node.js version matches (20 LTS)

---

## Maintenance

### View Logs

1. Go to **"Log stream"** for real-time logs
2. Go to **"Logs"** → **"App Service logs"** for historical logs

### Restart Application

1. Click **"Restart"** in the Overview page

### Scale Up/Down

1. Go to **"Scale up (App Service plan)"**
2. Select a different pricing tier

### Backup Database

1. Go to **"Advanced Tools"** → **"Go"**
2. Navigate to **Debug console** → **Bash**
3. Run: `cp /home/data/database.sqlite /home/data/backup-$(date +%Y%m%d).sqlite`

---

## Security Recommendations

1. **Change default admin password** immediately after deployment
2. **Use a strong JWT_SECRET** (32+ random characters)
3. **Enable HTTPS Only**: Go to Configuration → General settings → HTTPS Only: On
4. **Enable authentication logs**: Go to Diagnostic settings
5. **Set up alerts**: Go to Alerts to monitor application health

---

## Cost Estimation

| Plan | Monthly Cost | Storage | Best For |
|------|-------------|---------|----------|
| F1 (Free) | $0 | 1 GB | Testing |
| B1 (Basic) | ~$13 | 10 GB | Small teams |
| S1 (Standard) | ~$70 | 50 GB | Production |

---

## Quick Reference

| Item | Value |
|------|-------|
| Default Admin Email | `admin@codeally.com` |
| Default Admin Password | `Admin@123` |
| Database Location | `/home/data/database.sqlite` |
| Uploads Location | `/home/data/uploads/` |
| Required Node Version | 20 LTS |
| Required Environment Variables | `JWT_SECRET`, `NODE_ENV` |
