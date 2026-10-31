import type {
  BindingIdentifier,
  BindingPattern,
  BindingRestElement,
  ParamPattern,
} from "oxc-parser";

const bindingIdentifiersOf = (
  pattern: BindingPattern | BindingRestElement | null,
): readonly BindingIdentifier[] => {
  if (pattern === null) {
    return [];
  }
  switch (pattern.type) {
    case "Identifier": {
      return [pattern];
    }
    case "ObjectPattern": {
      return pattern.properties.flatMap((property) =>
        bindingIdentifiersOf(property.type === "RestElement" ? property : property.value),
      );
    }
    case "ArrayPattern": {
      return pattern.elements.flatMap(bindingIdentifiersOf);
    }
    case "AssignmentPattern": {
      return bindingIdentifiersOf(pattern.left);
    }
    case "RestElement": {
      return bindingIdentifiersOf(pattern.argument);
    }
  }
};

export const bindingNamesOf = (
  pattern: BindingPattern | BindingRestElement | null,
): readonly string[] => bindingIdentifiersOf(pattern).map(({ name }) => name);

const parameterIdentifiersOf = (parameter: ParamPattern): readonly BindingIdentifier[] => {
  if (parameter.type === "TSParameterProperty") {
    return bindingIdentifiersOf(parameter.parameter);
  }
  return parameter.type === "RestElement"
    ? bindingIdentifiersOf(parameter.argument)
    : bindingIdentifiersOf(parameter);
};

export const parameterNamesOf = (parameter: ParamPattern): readonly string[] =>
  parameterIdentifiersOf(parameter).map(({ name }) => name);
