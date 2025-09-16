const core = require('@actions/core');
const github = require('@actions/github');

try {
  const notifyUrl = core.getInput('notify-url');
  const message = core.getInput('message');

  const url = new URL(notifyUrl);
  
  fetch(url, {
    method: 'POST',
    headers: {'Content-Type': 'application/json; charset=UTF-8'},
    body: JSON.stringify({ 'text': message})
  });
} catch(e) {
   core.setFailed(e.message);
}

