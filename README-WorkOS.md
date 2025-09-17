# WorkOS Authentication Plugin for Cronicle

This plugin provides direct integration with WorkOS for Single Sign-On (SSO) authentication in Cronicle.

## Features

- **Direct WorkOS Integration**: Uses WorkOS APIs directly for enhanced control
- **Automatic User Creation**: Optionally creates users automatically on first login
- **Flexible User Mapping**: Map WorkOS profile attributes to Cronicle user fields
- **Dual Authentication Methods**: Supports both built-in OAuth profile and dedicated WorkOS plugin
- **Organization-specific SSO**: Connect users from specific WorkOS organizations
- **Avatar Support**: Sync user profile pictures from WorkOS

## Configuration

### Method 1: Using OAuth Profile (Recommended for simple setups)

```json
{
  "oauth": {
    "enabled": true,
    "profile": "workos",
    "client_id": "your_workos_client_id",
    "client_secret": "your_workos_client_secret",
    "redirect_uri": "http://your-domain.com/api/user/callback"
  }
}
```

### Method 2: Using Dedicated WorkOS Plugin (Recommended for advanced features)

```json
{
  "workos": {
    "enabled": true,
    "client_id": "your_workos_client_id",
    "client_secret": "your_workos_client_secret",
    "organization_id": "your_organization_id",
    "redirect_uri": "http://your-domain.com/api/workos/callback",
    "auto_create_users": true,
    "user_attribute_mapping": {
      "email": "email",
      "full_name": "first_name last_name",
      "avatar": "profile_picture_url"
    },
    "default_privileges": {
      "admin": 0,
      "create_events": 1,
      "edit_events": 1,
      "delete_events": 1,
      "run_events": 0,
      "abort_events": 0,
      "state_update": 0,
      "disable_enable_events": 0
    }
  }
}
```

## Setup Instructions

### 1. WorkOS Configuration

1. Log in to your WorkOS dashboard
2. Create or select your application
3. Note down your:
   - Client ID
   - Client Secret
   - Organization ID (optional, for organization-specific SSO)

### 2. Redirect URI Setup

Add the following redirect URI in your WorkOS application settings:
- For OAuth profile: `http://your-domain.com/api/user/callback`
- For WorkOS plugin: `http://your-domain.com/api/workos/callback`

### 3. Cronicle Configuration

Update your `conf/config.json` with the appropriate configuration (see examples above).

## Configuration Options

### WorkOS Plugin Options

| Option | Required | Description |
|--------|----------|-------------|
| `enabled` | Yes | Enable/disable WorkOS authentication |
| `client_id` | Yes | WorkOS client ID |
| `client_secret` | Yes | WorkOS client secret |
| `organization_id` | No | Restrict to specific organization |
| `redirect_uri` | Yes | Callback URL after authentication |
| `auto_create_users` | No | Automatically create users on first login (default: true) |
| `user_attribute_mapping` | No | Map WorkOS profile fields to user fields |
| `default_privileges` | No | Default privileges for new users |

### User Attribute Mapping

You can customize how WorkOS profile attributes map to Cronicle user fields:

```json
"user_attribute_mapping": {
  "email": "email",
  "full_name": "first_name last_name",
  "avatar": "profile_picture_url"
}
```

- Use dot notation for nested properties: `"company.name"`
- Use space-separated fields for concatenation: `"first_name last_name"`

## Usage

### For OAuth Profile Method

Users can log in by visiting: `http://your-domain.com/api/user/oauth`

### For WorkOS Plugin Method

Users can log in by visiting: `http://your-domain.com/api/workos/login`

Both methods will redirect to WorkOS for authentication and return to Cronicle upon success.

## Security Features

- **State Parameter**: Prevents CSRF attacks during OAuth flow
- **Session Management**: Integrates with Cronicle's existing session system
- **User Validation**: Validates user accounts and permissions
- **Token Security**: Uses secure token exchange with WorkOS

## Troubleshooting

### Common Issues

1. **"WorkOS is not configured" error**
   - Verify all required configuration fields are set
   - Check that `enabled` is set to `true`

2. **"Invalid authentication state" error**
   - Usually caused by stale or tampered state parameters
   - Clear browser cookies and try again

3. **User creation fails**
   - Check `auto_create_users` setting
   - Verify default privileges configuration
   - Review Cronicle logs for detailed error messages

### Debug Logging

Enable debug logging to troubleshoot authentication issues:

```json
{
  "debug_level": 5
}
```

Check the Cronicle logs for detailed WorkOS authentication flow information.

## API Endpoints

### WorkOS Plugin Endpoints

- `GET /api/workos/login` - Initiate WorkOS SSO login
- `GET /api/workos/callback` - Handle WorkOS callback

### OAuth Profile Endpoints

- `GET /api/user/oauth` - Initiate OAuth login
- `GET /api/user/callback` - Handle OAuth callback

## Development

The WorkOS plugin is implemented in `lib/auth-workos.js` and integrates with Cronicle's component system. It provides both a direct WorkOS integration and enhances the existing OAuth system with WorkOS-specific profiles.

## Support

For issues related to:
- **Cronicle integration**: Check Cronicle documentation and logs
- **WorkOS configuration**: Refer to WorkOS documentation
- **This plugin**: Review the plugin code and configuration examples above