import {
  forwardRef,
  isValidElement,
  memo,
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

type MockLegendListItemProps = {
  data: readonly unknown[];
  extraData: unknown;
  index: number;
  item: unknown;
  renderItem: (info: {
    data: readonly unknown[];
    extraData: unknown;
    index: number;
    item: unknown;
  }) => ReactNode;
};

const MockLegendListItem = memo(
  function MockLegendListItem({
    data,
    extraData,
    index,
    item,
    renderItem,
  }: MockLegendListItemProps) {
    return renderItem({ data, extraData, index, item });
  },
  (previous, next) =>
    previous.data === next.data &&
    previous.extraData === next.extraData &&
    previous.index === next.index &&
    previous.item === next.item,
);

export const LegendList = forwardRef(function MockLegendList<
  Item extends unknown,
>(
  {
    data,
    extraData,
    renderItem,
    keyExtractor,
    ListHeaderComponent,
    ListFooterComponent,
    className,
    style,
    "data-testid": dataTestId,
  }: {
    data: Item[];
    extraData?: unknown;
    renderItem: (info: {
      data: readonly Item[];
      extraData: unknown;
      item: Item;
      index: number;
    }) => ReactNode;
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
          <MockLegendListItem
            key={keyExtractor?.(item, index) ?? index}
            data={data}
            extraData={extraData}
            index={index}
            item={item}
            renderItem={renderItem as MockLegendListItemProps["renderItem"]}
          />
        ))}
        {renderOptionalComponent(ListFooterComponent)}
      </div>
    </div>
  );
});
