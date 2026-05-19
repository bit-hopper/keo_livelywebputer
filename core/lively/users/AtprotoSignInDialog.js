// Complete AT Protocol Authentication UI
// Includes both Main Dialog and Sign In Dialog

// Main Dialog (launcher)
function createAtprotoMainDialog() {
  var mainDialog = new lively.morphic.Box(lively.rect(150, 150, 500, 380));
  mainDialog.setName("AtprotoMainDialog");
  mainDialog.setFill(Color.rgb(238, 238, 238)); // Light gray background #eeeeee
  mainDialog.setBorderColor(Color.rgba(240, 26, 105, 1)); // F01A69
  mainDialog.setBorderWidth(2);
  mainDialog.setBorderRadius(8); // Subtly rounded corners

  // Header/Titlebar with pink background
  var headerBox = new lively.morphic.Box(lively.rect(0, 0, 500, 70));
  headerBox.setFill(Color.rgba(240, 26, 105, 0.9)); // F01A69 with slight transparency
  headerBox.setBorderRadius(8);
  headerBox.grabEnabled = false;
  mainDialog.addMorph(headerBox);

  // Title - white text on pink header (borderless)
  var title = new lively.morphic.Text(lively.rect(20, 15, 460, 40));
  title.setTextString("Welcome to Lively Kernel");
  title.setFontSize(22);
  title.setFontWeight("bold");
  title.setTextColor(Color.white);
  title.setFill(Color.transparent);
  title.setBorderWidth(0);
  title.setAlign("center");
  headerBox.addMorph(title);

  // Subtitle - centered (borderless)
  var subtitle = new lively.morphic.Text(lively.rect(30, 85, 440, 40));
  subtitle.setTextString("Sign in with your AT Protocol account");
  subtitle.setFontSize(14);
  subtitle.setFill(Color.transparent);
  subtitle.setBorderWidth(0);
  subtitle.setAlign("center");
  mainDialog.addMorph(subtitle);

  // Sign In button
  var signInBtn = new lively.morphic.Button(lively.rect(75, 150, 350, 50));
  signInBtn.setLabel("Sign In");
  signInBtn.setFill(Color.rgb(43, 88, 255));
  signInBtn.setBorderRadius(6);
  signInBtn.onMouseUp = function (evt) {
    // Create Sign In dialog with rounded corners
    var signInDialog = new lively.morphic.Box(lively.rect(150, 100, 500, 600));
    signInDialog.setName("AtprotoSignInDialog");
    signInDialog.setFill(Color.rgb(238, 238, 238)); // Light gray background #eeeeee
    signInDialog.setBorderColor(Color.rgba(240, 26, 105, 1)); // F01A69
    signInDialog.setBorderWidth(2);
    signInDialog.setBorderRadius(8); // Subtly rounded corners

    // Header/Titlebar with pink background
    var headerBox = new lively.morphic.Box(lively.rect(0, 0, 500, 70));
    headerBox.setFill(Color.rgba(240, 26, 105, 0.9)); // F01A69 with slight transparency
    headerBox.setBorderRadius(8);
    headerBox.grabEnabled = false;
    signInDialog.addMorph(headerBox);

    // Title - white text on pink header (borderless)
    var signinTitle = new lively.morphic.Text(lively.rect(20, 15, 460, 40));
    signinTitle.setTextString("Sign in with at:// protocol");
    signinTitle.setFontSize(22);
    signinTitle.setFontWeight("bold");
    signinTitle.setTextColor(Color.white);
    signinTitle.setFill(Color.transparent);
    signinTitle.setBorderWidth(0);
    signinTitle.setAlign("center");
    headerBox.addMorph(signinTitle);

    // Hosting Provider label - centered (borderless)
    var providerLabel = new lively.morphic.Text(lively.rect(50, 85, 400, 20));
    providerLabel.setTextString("Hosting Provider");
    providerLabel.setFontSize(14);
    providerLabel.setFontWeight("600");
    providerLabel.setFill(Color.transparent);
    providerLabel.setBorderWidth(0);
    providerLabel.setAlign("center");
    signInDialog.addMorph(providerLabel);

    // Hosting Provider input - rounded corners
    var providerInput = new lively.morphic.Text(lively.rect(75, 110, 350, 40));
    providerInput.setTextString("lively.world");
    providerInput.setFontSize(16);
    providerInput.setFill(Color.white);
    providerInput.setBorderColor(Color.rgb(200, 200, 200));
    providerInput.setBorderWidth(1);
    providerInput.setBorderRadius(8);
    providerInput.allowInput = true;
    providerInput.setName("ProviderInput");
    providerInput.addScript(function onEnterPressed(evt) {
      evt.stop();
      return true;
    });
    signInDialog.addMorph(providerInput);

    // Account section container - F7C2D6 color with 0.1 opacity, rounded corners, houses all form fields
    var accountContainer = new lively.morphic.Box(
      lively.rect(40, 175, 420, 300),
    );
    accountContainer.setFill(Color.rgba(247, 194, 214, 0.1)); // F7C2D6 with 0.1 opacity
    accountContainer.setBorderColor(Color.rgba(247, 194, 214, 0.3));
    accountContainer.setBorderWidth(1);
    accountContainer.setBorderRadius(16);
    signInDialog.addMorph(accountContainer);

    // Account label - centered (borderless) inside container
    var accountLabel = new lively.morphic.Text(lively.rect(20, 20, 380, 25));
    accountLabel.setTextString("Account");
    accountLabel.setFontSize(13);
    accountLabel.setFontWeight("600");
    accountLabel.setFill(Color.transparent);
    accountLabel.setBorderWidth(0);
    accountLabel.setAlign("center");
    accountContainer.addMorph(accountLabel);

    // Username label - centered (borderless) inside container
    var usernameLabel = new lively.morphic.Text(lively.rect(20, 65, 380, 20));
    usernameLabel.setTextString("Username");
    usernameLabel.setFontSize(14);
    usernameLabel.setFontWeight("600");
    usernameLabel.setFill(Color.transparent);
    usernameLabel.setBorderWidth(0);
    usernameLabel.setAlign("center");
    accountContainer.addMorph(usernameLabel);

    // Username input - rounded corners inside container
    var usernameInput = new lively.morphic.Text(lively.rect(35, 90, 350, 40));
    usernameInput.setTextString("@username");
    usernameInput.setFontSize(16);
    usernameInput.setFill(Color.white);
    usernameInput.setBorderColor(Color.rgb(200, 200, 200));
    usernameInput.setBorderWidth(1);
    usernameInput.setBorderRadius(8);
    usernameInput.allowInput = true;
    usernameInput.setName("UsernameInput");
    usernameInput.addScript(function onEnterPressed(evt) {
      evt.stop();
      return true;
    });
    accountContainer.addMorph(usernameInput);

    // Password label - centered (borderless) inside container
    var passwordLabel = new lively.morphic.Text(lively.rect(20, 150, 380, 20));
    passwordLabel.setTextString("Password");
    passwordLabel.setFontSize(14);
    passwordLabel.setFontWeight("600");
    passwordLabel.setFill(Color.transparent);
    passwordLabel.setBorderWidth(0);
    passwordLabel.setAlign("center");
    accountContainer.addMorph(passwordLabel);

    // Password input - rounded corners inside container
    var passwordInput = new lively.morphic.Text(lively.rect(35, 175, 350, 40));
    passwordInput.setTextString("");
    passwordInput.setFontSize(16);
    passwordInput.setFill(Color.white);
    passwordInput.setBorderColor(Color.rgb(200, 200, 200));
    passwordInput.setBorderWidth(1);
    passwordInput.setBorderRadius(8);
    passwordInput.allowInput = true;
    passwordInput.setName("PasswordInput");
    passwordInput.addScript(function onEnterPressed(evt) {
      evt.stop();
      return true;
    });
    accountContainer.addMorph(passwordInput);

    // Back button
    var backBtn = new lively.morphic.Button(lively.rect(75, 510, 150, 50));
    backBtn.setLabel("Back");
    backBtn.setFill(Color.rgb(220, 220, 220));
    backBtn.setBorderRadius(6);
    backBtn.onMouseUp = function (evt) {
      signInDialog.remove();
      $world.addMorph(mainDialog);
    };
    signInDialog.addMorph(backBtn);

    // Sign In button (in dialog)
    var dialogSignInBtn = new lively.morphic.Button(
      lively.rect(275, 510, 150, 50),
    );
    dialogSignInBtn.setLabel("Sign In");
    dialogSignInBtn.setFill(Color.rgb(43, 88, 255));
    dialogSignInBtn.setBorderRadius(6);
    dialogSignInBtn.onMouseUp = function (evt) {
      var provider = providerInput.textString;
      var username = usernameInput.textString;
      var password = passwordInput.textString;

      if (!provider || provider.trim() === "") {
        alertOK("Please enter hosting provider");
        return;
      }
      if (!username || username.trim() === "") {
        alertOK("Please enter username");
        return;
      }
      if (!password || password.trim() === "") {
        alertOK("Please enter password");
        return;
      }

      // Show loading message
      var originalLabel = dialogSignInBtn.getLabel();
      dialogSignInBtn.setLabel("Signing in...");
      dialogSignInBtn.submorphs[0].setTextString("Signing in...");

      // Call backend authentication endpoint
      fetch("/nodejs/ATProtoAuthTest/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          pdsUrl: provider,
          handle: username,
          password: password,
        }),
      })
        .then(function (response) {
          return response.json().then(function (data) {
            if (!response.ok) {
              // Build error message from backend response
              var errorMsg = data.error || "Authentication failed";
              if (data.details) {
                errorMsg += ": " + data.details;
              }
              throw new Error(errorMsg);
            }
            return data;
          });
        })
        .then(function (data) {
          // Verify response has required fields
          if (!data.user || !data.user.did) {
            throw new Error("Invalid server response: missing user data");
          }

          // Store session token and user info
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("atproto_token", data.token);
            localStorage.setItem("atproto_did", data.user.did);
            localStorage.setItem("atproto_handle", data.user.handle);
            localStorage.setItem("atproto_session_id", data.sessionId);
            if (data.pdsUrl) {
              localStorage.setItem("atproto_pds_url", data.pdsUrl);
            }
          }

          // Success message with real user details
          alertOK(
            "✓ Successfully signed in!\n\n" +
              "Handle: " +
              data.user.handle +
              "\n" +
              "DID: " +
              data.user.did,
          );

          // Clean up
          signInDialog.remove();
          mainDialog.remove();
        })
        .catch(function (error) {
          // Reset button
          dialogSignInBtn.setLabel(originalLabel);
          dialogSignInBtn.submorphs[0].setTextString(originalLabel);

          // Format error message with helpful hints
          var errorMsg = "✗ Sign in failed\n\n";
          var fullError = error.message || "Unknown error";

          if (
            fullError.includes("Invalid handle") ||
            fullError.includes("Invalid password") ||
            fullError.includes("Invalid credentials")
          ) {
            errorMsg +=
              "Invalid credentials\n\n" +
              "Please check:\n" +
              "• Handle format (e.g., user.bsky.social)\n" +
              "• Password is correct\n" +
              "• Account exists on the server";
          } else if (fullError.includes("PDS unavailable")) {
            errorMsg +=
              "Server unavailable\n\n" +
              "The PDS server could not be reached.\n" +
              "Please try again or verify your server URL.";
          } else if (
            fullError.includes("Could not resolve PDS") ||
            fullError.includes("Invalid handle format")
          ) {
            errorMsg +=
              "Handle resolution failed\n\n" +
              "Could not find the PDS server for this handle.\n" +
              "Please provide an explicit PDS URL or use a known handle.";
          } else {
            errorMsg += fullError;
          }

          alertOK(errorMsg);
          console.error("AT Proto authentication error:", error);
        });
    };
    signInDialog.addMorph(dialogSignInBtn);

    mainDialog.remove();
    $world.addMorph(signInDialog);
  };
  mainDialog.addMorph(signInBtn);

  // Create Account button
  var createBtn = new lively.morphic.Button(lively.rect(75, 220, 350, 50));
  createBtn.setLabel("Create Account");
  createBtn.setFill(Color.rgb(200, 200, 200));
  createBtn.setBorderRadius(6);
  createBtn.onMouseUp = function (evt) {
    alertOK("Create Account feature coming soon");
  };
  mainDialog.addMorph(createBtn);

  return mainDialog;
}

// Execute when loaded
(function () {
  var mainDialog = createAtprotoMainDialog();
  $world.addMorph(mainDialog);
})();
