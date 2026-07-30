import {
  Fragment,
  forwardRef,
  isValidElement,
  useImperativeHandle,
  useRef,
  type ComponentType,
  type ForwardedRef,
  type ReactNode,
} from "react";

type OptionalComponent = ReactNode | ComponentType;

const renderOptionalComponent = (component: OptionalComponent) => {
  if (typeof component === "function") {
    const Component = component;
    return <Component />;
  }

  return isValidElement(component) ? component : null;
};

export const LegendList = forwardRef(function MockLegendList<
  Item extends unknown,
>(
  {
    data,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListFooterComponent,
    className,
    style,
    "data-testid": dataTestId,
  }: {
    data: Item[];
    renderItem: (info: { item: Item; index: number }) => ReactNode;
    keyExtractor?: (item: Item, index: number) => string;
    ListHeaderComponent?: OptionalComponent;
    ListFooterComponent?: OptionalComponent;
    className?: string;
    style?: React.CSSProperties;
    "data-testid"?: string;
  },
  forwardedRef: ForwardedRef<{
    getScrollableNode: () => HTMLDivElement | null;
  }>,
) {
  const scrollElementRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    forwardedRef,
    () => ({
      getScrollableNode: () => scrollElementRef.current,
    }),
    [],
  );

  return (
    <div
      ref={scrollElementRef}
      className={className}
      style={style}
      data-testid={dataTestId}
    >
      <div className="legend-list-content-container">
        {renderOptionalComponent(ListHeaderComponent)}
        {data.map((item, index) => (
          <Fragment key={keyExtractor?.(item, index) ?? index}>
            {renderItem({ item, index })}
          </Fragment>
        ))}
        {renderOptionalComponent(ListFooterComponent)}
      </div>
    </div>
  );
});
