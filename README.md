# Payments

[![node](https://img.shields.io/badge/node-16.4-brightgreen)](https://nodejs.org/download/release/latest-fermium/)

## Get started

- Install and use Node v16 (last LTS).
- Install yarn (`npm i -g yarn`)
- Run the needed services with `cd infrastructure && docker-compose up`
- Rename `.env.template` to `.env` and fill the empty variables
- Redirect webhooks to your local server `stripe listen --forward-to localhost:8000/webhook`
- Run `yarn dev`

### Nice to know

- If you go to `localhost:8082` you'll see a GUI to inspect the mongodb instance
- Install prettier & eslint vscode extensions for a better dev experience.
