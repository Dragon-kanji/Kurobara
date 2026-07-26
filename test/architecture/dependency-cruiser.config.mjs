import rootConfig from "../../.dependency-cruiser.mjs";

export default {
  ...rootConfig,
  options: {
    ...rootConfig.options,
    tsConfig: {
      fileName: ".dependency-cruiser.test.tsconfig.json",
    },
  },
};
