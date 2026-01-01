import swaggerJsdoc from "swagger-jsdoc";
import swaggerUi from "swagger-ui-express";
import { Express } from "express";

export const setupSwagger = (app: Express) => {
  const options: any = {
    // <- use 'any' here
    definition: {
      openapi: "3.0.0",
      info: {
        title: "Gaznger App API",
        version: "1.0.0",
        description: "API documentation for Gaznger app backend",
      },
      servers: [
        {
          url: "https://gaznger-backend.onrender.com",
        },
      ],
    },
    apis: ["./src/routes/*.ts"],
  };

  const specs = swaggerJsdoc(options);
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(specs));
};
